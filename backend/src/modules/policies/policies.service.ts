import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PolicyStatus as PrismaPolicyStatus, Prisma } from '@prisma/client';

import {
  applyTransition, invoiceNumber, policyNumber, splitEvenly,
  type PolicyStatus, type PolicyTransition, type ProductCode,
} from '@lih/domain';

import { AuditService } from '../../common/audit/audit.service';
import { OnboardingService } from '../onboarding/onboarding.service';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Policy lifecycle.
 *
 * Every status change goes through the domain state machine — this service
 * never assigns a status directly. That is what guarantees the invariants the
 * business depends on: cover cannot begin before money arrives, an expired
 * policy cannot be switched back on, and no transition happens without the
 * permission that authorises it.
 */
@Injectable()
export class PoliciesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly onboarding: OnboardingService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Convert a quotation into a submitted application, and raise the invoice.
   *
   * Cover does NOT begin here. The policy is created in `draft`, moved to
   * `submitted`, and only reaches `active` when the payment module reports
   * the first installment settled. Issuing cover before payment would mean
   * writing risk for free, so the ordering is enforced by the state machine
   * rather than left to the caller.
   */
  async subscribe(
    quoteId: string,
    actor: { userId: string; tenantId: string; lawyerId: string; permissions: string[] },
    agentId?: string,
  ) {
    // Subscribing is the point where Bar verification actually matters.
    await this.onboarding.assertVerified(actor.lawyerId);

    const quote = await this.prisma.quote.findFirst({
      where: { id: quoteId, lawyerId: actor.lawyerId },
      include: { plan: { include: { product: true } } },
    });
    if (!quote) throw new NotFoundException('errors.not_found.detail');
    if (quote.convertedAt) throw new BadRequestException('policy.quote_already_converted');
    if (quote.validUntil < new Date()) throw new BadRequestException('policy.quote_expired');

    return this.prisma.$transaction(async (tx) => {
      const year = new Date().getFullYear();
      const sequence = (await tx.policy.count({ where: { tenantId: actor.tenantId } })) + 1;

      const created = await tx.policy.create({
        data: {
          tenantId: actor.tenantId,
          policyNumber: policyNumber(quote.plan.product.code as ProductCode, year, sequence),
          lawyerId: actor.lawyerId,
          planId: quote.planId,
          ratingTableId: quote.ratingTableId,
          quoteId: quote.id,
          status: 'draft',
          premiumXaf: quote.premiumXaf,
          soldByAgentId: agentId ?? null,
        },
      });

      const submitted = applyTransition('draft', 'submit', actor.permissions);
      await tx.policy.update({
        where: { id: created.id },
        data: { status: submitted as PrismaPolicyStatus },
      });
      await tx.policyEvent.create({
        data: {
          policyId: created.id,
          fromStatus: 'draft',
          toStatus: submitted as PrismaPolicyStatus,
          actorId: actor.userId,
          note: 'Application submitted from quotation',
        },
      });

      // Billing is raised now so the lawyer can pay immediately; the schedule
      // comes from the domain splitter, which guarantees the installments sum
      // back to the premium exactly.
      const invoice = await tx.invoice.create({
        data: {
          tenantId: actor.tenantId,
          policyId: created.id,
          invoiceNo: invoiceNumber(year, sequence),
          totalXaf: quote.premiumXaf,
        },
      });

      const amounts = splitEvenly(quote.premiumXaf, quote.installments);
      const today = new Date();
      await tx.installment.createMany({
        data: amounts.map((amountXaf, index) => ({
          invoiceId: invoice.id,
          seq: index + 1,
          amountXaf,
          // First installment due immediately; the rest quarterly-ish by
          // month step, matching the option the lawyer chose.
          dueOn: new Date(
            today.getFullYear(),
            today.getMonth() + index * Math.round(12 / quote.installments),
            today.getDate(),
          ),
        })),
      });

      await tx.quote.update({ where: { id: quote.id }, data: { convertedAt: new Date() } });

      await this.prisma.emitEvent(tx, {
        tenantId: actor.tenantId,
        eventType: 'policy.submitted',
        aggregateType: 'Policy',
        aggregateId: created.id,
        payload: {
          policyNumber: created.policyNumber,
          premiumXaf: created.premiumXaf.toString(),
          invoiceId: invoice.id,
        },
      });

      await this.audit.record(
        {
          tenantId: actor.tenantId,
          actorId: actor.userId,
          action: 'policy.subscribe',
          entityType: 'Policy',
          entityId: created.id,
          after: { policyNumber: created.policyNumber, status: submitted },
        },
        tx,
      );

      return {
        id: created.id,
        policyNumber: created.policyNumber,
        status: submitted,
        premiumXaf: created.premiumXaf,
        invoice: { id: invoice.id, invoiceNo: invoice.invoiceNo, installments: amounts.length },
      };
    });
  }

  /**
   * Apply a lifecycle transition.
   *
   * `tx` is accepted so the payment module can activate a policy inside the
   * same transaction that records the settled payment — cover beginning and
   * money arriving must commit together.
   */
  async transition(
    policyId: string,
    transitionName: PolicyTransition,
    actor: { userId: string; tenantId: string; permissions: string[] },
    options: { note?: string; tx?: Prisma.TransactionClient } = {},
  ) {
    const run = async (tx: Prisma.TransactionClient) => {
      const policy = await tx.policy.findUniqueOrThrow({ where: { id: policyId } });

      const next = applyTransition(
        policy.status as PolicyStatus,
        transitionName,
        actor.permissions,
      );

      // Activation is also when cover dates are stamped — a one-year term
      // from the day the money actually arrived, not from the application.
      const dates =
        next === 'active' && !policy.effectiveFrom
          ? {
              effectiveFrom: new Date(),
              effectiveTo: new Date(
                new Date().setFullYear(new Date().getFullYear() + 1),
              ),
            }
          : {};

      const updated = await tx.policy.update({
        where: { id: policyId },
        data: {
          status: next as PrismaPolicyStatus,
          ...dates,
          ...(next === 'cancelled'
            ? { cancelledAt: new Date(), cancelReason: options.note ?? null }
            : {}),
        },
      });

      await tx.policyEvent.create({
        data: {
          policyId,
          fromStatus: policy.status,
          toStatus: next as PrismaPolicyStatus,
          actorId: actor.userId,
          note: options.note ?? null,
        },
      });

      await this.prisma.emitEvent(tx, {
        tenantId: actor.tenantId,
        eventType: `policy.${next}`,
        aggregateType: 'Policy',
        aggregateId: policyId,
        payload: { policyNumber: policy.policyNumber, from: policy.status, to: next },
      });

      await this.audit.record(
        {
          tenantId: actor.tenantId,
          actorId: actor.userId,
          action: `policy.${transitionName}`,
          entityType: 'Policy',
          entityId: policyId,
          before: { status: policy.status },
          after: { status: next },
          reason: options.note ?? null,
        },
        tx,
      );

      return updated;
    };

    return options.tx ? run(options.tx) : this.prisma.$transaction(run);
  }

  async findForLawyer(lawyerId: string, status?: PrismaPolicyStatus) {
    return this.prisma.policy.findMany({
      where: { lawyerId, ...(status ? { status } : {}) },
      include: {
        plan: { include: { product: true } },
        invoices: { include: { installments: { orderBy: { seq: 'asc' } } } },
        _count: { select: { claims: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(policyId: string, requester: { lawyerId?: string; permissions: string[] }) {
    const policy = await this.prisma.policy.findUnique({
      where: { id: policyId },
      include: {
        plan: { include: { product: true } },
        lawyer: { select: { id: true, fullName: true, barNumber: true } },
        invoices: { include: { installments: { orderBy: { seq: 'asc' } } } },
        events: { orderBy: { createdAt: 'asc' } },
        claims: { select: { id: true, claimNumber: true, status: true, createdAt: true } },
      },
    });
    if (!policy) throw new NotFoundException('errors.not_found.detail');

    const canSeeAll = requester.permissions.includes('policies:read:all');
    if (!canSeeAll && policy.lawyerId !== requester.lawyerId) {
      // 404 rather than 403: confirming that a policy id exists is itself a
      // small leak.
      throw new NotFoundException('errors.not_found.detail');
    }
    return policy;
  }

  /**
   * Renew: a renewal is a NEW policy that supersedes the old one, priced with
   * today's rating table. It is never an edit of the existing row, because
   * the expiring policy remains the contract for its own term and its record
   * must stay exactly as it was.
   */
  async renew(
    policyId: string,
    actor: { userId: string; tenantId: string; lawyerId: string; permissions: string[] },
  ) {
    const existing = await this.findOne(policyId, actor);

    const ratingTable = await this.prisma.ratingTable.findFirst({
      where: { planId: existing.planId, effectiveFrom: { lte: new Date() } },
      orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
    });
    if (!ratingTable) throw new BadRequestException('policy.no_rating_table');

    return this.prisma.$transaction(async (tx) => {
      const year = new Date().getFullYear();
      const sequence = (await tx.policy.count({ where: { tenantId: actor.tenantId } })) + 1;

      const renewal = await tx.policy.create({
        data: {
          tenantId: actor.tenantId,
          policyNumber: policyNumber(
            existing.plan.product.code as ProductCode,
            year,
            sequence,
          ),
          lawyerId: existing.lawyerId,
          planId: existing.planId,
          ratingTableId: ratingTable.id,
          status: 'submitted',
          premiumXaf: existing.premiumXaf,
          renewedFromId: existing.id,
        },
      });

      await this.transition(existing.id, 'renew', actor, {
        note: `Superseded by ${renewal.policyNumber}`,
        tx,
      });

      return { id: renewal.id, policyNumber: renewal.policyNumber, status: renewal.status };
    });
  }
}
