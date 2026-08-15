import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { ClaimStatus as PrismaClaimStatus, Prisma } from '@prisma/client';

import {
  applyClaimTransition, availableClaimTransitions, claimNumber, slaState,
  type ClaimStatus, type ClaimTransition,
} from '@lih/domain';

import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { FileClaimDto, TransitionClaimDto } from './dto/claims.dto';

/**
 * Claims handling.
 *
 * The workflow is the officer's job queue and the insurer's evidence trail at
 * the same time. Two rules hold throughout:
 *
 *   * Every transition is written to claim_events with its actor. That table
 *     is the record a regulator or a court would read, so a status that
 *     changed without an event would be a hole in the evidence.
 *   * The fraud score sorts the queue and nothing else. It never rejects a
 *     claim and never blocks a payout — an advisory model that silently
 *     denies cover to a real claimant is both an unfair outcome and a
 *     regulatory problem.
 */
@Injectable()
export class ClaimsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * File a claim against an active policy.
   *
   * The three validations here are the ones that stop bad claims entering the
   * pipeline at all: cover must be active, the incident must fall inside the
   * cover period, and it must be in the past.
   */
  async file(
    dto: FileClaimDto,
    actor: { userId: string; tenantId: string; lawyerId?: string; permissions: string[] },
  ) {
    const policy = await this.prisma.policy.findUnique({
      where: { id: dto.policyId },
      select: {
        id: true, lawyerId: true, status: true, effectiveFrom: true,
        effectiveTo: true, policyNumber: true,
      },
    });
    if (!policy) throw new NotFoundException('errors.not_found.detail');

    if (policy.lawyerId !== actor.lawyerId && !actor.permissions.includes('claims:read:all')) {
      throw new NotFoundException('errors.not_found.detail');
    }
    if (policy.status !== 'active') {
      throw new BadRequestException('claims.policy_not_active');
    }

    const incidentAt = new Date(dto.incidentAt);
    if (incidentAt > new Date()) {
      throw new BadRequestException('claims.incident_in_future');
    }
    if (policy.effectiveFrom && incidentAt < policy.effectiveFrom) {
      throw new BadRequestException('claims.incident_before_cover');
    }
    if (policy.effectiveTo && incidentAt > policy.effectiveTo) {
      throw new BadRequestException('claims.incident_before_cover');
    }

    return this.prisma.$transaction(async (tx) => {
      const year = new Date().getFullYear();
      const sequence = (await tx.claim.count({ where: { tenantId: actor.tenantId } })) + 1;

      const fraud = this.scoreFraud({
        claimedXaf: dto.claimedXaf ? BigInt(dto.claimedXaf) : null,
        incidentAt,
        policyEffectiveFrom: policy.effectiveFrom,
      });

      const claim = await tx.claim.create({
        data: {
          tenantId: actor.tenantId,
          claimNumber: claimNumber(year, sequence),
          policyId: policy.id,
          filedById: actor.userId,
          status: 'submitted',
          incidentAt,
          incidentPlace: dto.incidentPlace ?? null,
          incidentGeo: (dto.incidentGeo as Prisma.InputJsonValue) ?? undefined,
          description: dto.description,
          claimedXaf: dto.claimedXaf ? BigInt(dto.claimedXaf) : null,
          fraudScore: fraud.score,
          fraudFactors: fraud.factors as Prisma.InputJsonValue,
          // First response clock starts immediately.
          slaDueAt: new Date(Date.now() + 48 * 3_600_000),
        },
      });

      await tx.claimEvent.create({
        data: {
          claimId: claim.id,
          fromStatus: null,
          toStatus: 'submitted',
          actorId: actor.userId,
          note: 'Claim filed',
        },
      });

      await this.prisma.emitEvent(tx, {
        tenantId: actor.tenantId,
        eventType: 'claim.submitted',
        aggregateType: 'Claim',
        aggregateId: claim.id,
        payload: {
          claimNumber: claim.claimNumber,
          policyNumber: policy.policyNumber,
          fraudScore: fraud.score,
        },
      });

      await this.audit.record(
        {
          tenantId: actor.tenantId,
          actorId: actor.userId,
          action: 'claim.file',
          entityType: 'Claim',
          entityId: claim.id,
          after: { claimNumber: claim.claimNumber, policyId: policy.id },
        },
        tx,
      );

      return claim;
    });
  }

  /**
   * Heuristic fraud signals available at filing time.
   *
   * This is deliberately a small, explainable rule set rather than an opaque
   * model. Phase 2 replaces the scoring function with the trained gradient-
   * boosted model, but the contract stays the same: a score plus the factors
   * that produced it, both shown to the officer. An officer who cannot see
   * why a claim was flagged cannot act on the flag responsibly.
   */
  private scoreFraud(input: {
    claimedXaf: bigint | null;
    incidentAt: Date;
    policyEffectiveFrom: Date | null;
  }): { score: number; factors: Record<string, unknown> } {
    const factors: Record<string, unknown> = {};
    let score = 0.05; // base rate

    if (input.policyEffectiveFrom) {
      const daysIntoCover =
        (input.incidentAt.getTime() - input.policyEffectiveFrom.getTime()) / 86_400_000;
      if (daysIntoCover <= 14) {
        score += 0.35;
        factors.early_incident = `Incident ${Math.round(daysIntoCover)} days into cover`;
      }
    }

    const reportingLagDays = (Date.now() - input.incidentAt.getTime()) / 86_400_000;
    if (reportingLagDays > 30) {
      score += 0.2;
      factors.late_report = `Reported ${Math.round(reportingLagDays)} days after the incident`;
    }

    if (input.claimedXaf && input.claimedXaf > 10_000_000n) {
      score += 0.15;
      factors.high_value = `Claimed ${input.claimedXaf.toString()} XAF`;
    }

    return { score: Math.min(Math.round(score * 1000) / 1000, 1), factors };
  }

  /** The officer workbench queue, most urgent first. */
  async queue(tenantId: string, assignedToId?: string) {
    const claims = await this.prisma.claim.findMany({
      where: {
        tenantId,
        status: { notIn: ['closed', 'rejected'] },
        ...(assignedToId ? { assignedToId } : {}),
      },
      include: {
        policy: {
          select: {
            policyNumber: true,
            plan: { select: { nameEn: true, nameFr: true, product: { select: { code: true } } } },
            lawyer: { select: { fullName: true, barNumber: true } },
          },
        },
        _count: { select: { documents: true } },
      },
      orderBy: [{ slaDueAt: 'asc' }],
      take: 100,
    });

    const now = new Date();
    return claims.map((c) => ({
      ...c,
      sla: slaState(c.slaDueAt, now),
    }));
  }

  async findOne(claimId: string, requester: { lawyerId?: string; permissions: string[] }) {
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
      include: {
        policy: {
          select: { id: true, policyNumber: true, lawyerId: true, plan: { select: { nameEn: true, nameFr: true } } },
        },
        events: {
          orderBy: { createdAt: 'asc' },
          include: { actor: { select: { email: true } } },
        },
        documents: {
          select: { id: true, kind: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
        },
        payments: { select: { id: true, amountXaf: true, status: true, provider: true, createdAt: true } },
      },
    });
    if (!claim) throw new NotFoundException('errors.not_found.detail');

    const canSeeAll = requester.permissions.includes('claims:read:all');
    if (!canSeeAll && claim.policy.lawyerId !== requester.lawyerId) {
      throw new NotFoundException('errors.not_found.detail');
    }

    return {
      ...claim,
      sla: slaState(claim.slaDueAt),
      availableTransitions: availableClaimTransitions(
        claim.status as ClaimStatus,
        requester.permissions,
      ),
    };
  }

  async listForLawyer(lawyerId: string) {
    return this.prisma.claim.findMany({
      where: { policy: { lawyerId } },
      include: { policy: { select: { policyNumber: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Move a claim through the workflow.
   *
   * The domain machine decides legality, permission and the new SLA deadline
   * together; this method only persists what it returns.
   */
  async transition(
    claimId: string,
    transitionName: ClaimTransition,
    dto: TransitionClaimDto,
    actor: { userId: string; tenantId: string; permissions: string[] },
    tx?: Prisma.TransactionClient,
  ) {
    const run = async (client: Prisma.TransactionClient) => {
      const claim = await client.claim.findUniqueOrThrow({ where: { id: claimId } });

      const approvedXaf = dto.approvedXaf ? BigInt(dto.approvedXaf) : claim.approvedXaf;

      if (transitionName === 'reject' && !dto.note?.trim()) {
        throw new BadRequestException('A reason is required when rejecting a claim');
      }
      if (approvedXaf && claim.claimedXaf && approvedXaf > claim.claimedXaf) {
        throw new BadRequestException('The approved amount cannot exceed the amount claimed');
      }

      const { status, slaDueAt } = applyClaimTransition(
        claim.status as ClaimStatus,
        transitionName,
        actor.permissions,
        { approvedXaf },
      );

      const updated = await client.claim.update({
        where: { id: claimId },
        data: {
          status: status as PrismaClaimStatus,
          slaDueAt,
          ...(approvedXaf !== null && approvedXaf !== undefined ? { approvedXaf } : {}),
          ...(transitionName === 'reject' ? { rejectionReason: dto.note } : {}),
          ...(status === 'closed' ? { closedAt: new Date() } : {}),
          ...(dto.assignToId ? { assignedToId: dto.assignToId } : {}),
        },
      });

      await client.claimEvent.create({
        data: {
          claimId,
          fromStatus: claim.status,
          toStatus: status as PrismaClaimStatus,
          actorId: actor.userId,
          note: dto.note ?? null,
          metadata: approvedXaf ? { approvedXaf: approvedXaf.toString() } : undefined,
        },
      });

      await this.prisma.emitEvent(client, {
        tenantId: actor.tenantId,
        eventType: `claim.${status}`,
        aggregateType: 'Claim',
        aggregateId: claimId,
        payload: {
          claimNumber: claim.claimNumber,
          from: claim.status,
          to: status,
          approvedXaf: approvedXaf?.toString() ?? null,
        },
      });

      await this.audit.record(
        {
          tenantId: actor.tenantId,
          actorId: actor.userId,
          action: `claim.${transitionName}`,
          entityType: 'Claim',
          entityId: claimId,
          before: { status: claim.status, approvedXaf: claim.approvedXaf?.toString() },
          after: { status, approvedXaf: approvedXaf?.toString() },
          reason: dto.note ?? null,
        },
        client,
      );

      return updated;
    };

    return tx ? run(tx) : this.prisma.$transaction(run);
  }
}
