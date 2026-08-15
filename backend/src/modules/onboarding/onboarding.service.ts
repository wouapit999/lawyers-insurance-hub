import {
  BadRequestException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import type { Prisma, VerificationStatus } from '@prisma/client';

import { beneficiaryCardNumber } from '@lih/domain';

import { AuditService } from '../../common/audit/audit.service';
import { CryptoService } from '../../common/security/crypto.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  CreateBeneficiaryDto, CreateVehicleDto, UpdateProfileDto, VerificationDecisionDto,
} from './dto/onboarding.dto';

/**
 * Lawyer onboarding: profiles, Bar Association verification, family
 * beneficiaries and vehicles.
 *
 * The verification workflow is the partnership's control point. Only a Bar
 * administrator can move a lawyer to `verified`, the decision is recorded
 * with the register snapshot it was based on, and the whole history is kept —
 * a later dispute about whether someone was in good standing on a given date
 * has to be answerable from this table.
 */
@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  // =========================================================================
  // Profile
  // =========================================================================

  async getProfile(lawyerId: string) {
    const profile = await this.prisma.lawyerProfile.findUniqueOrThrow({
      where: { id: lawyerId },
      include: {
        lawFirm: true,
        user: { select: { email: true, phoneE164: true, preferredLang: true } },
        verifications: { orderBy: { submittedAt: 'desc' }, take: 1 },
        _count: { select: { beneficiaries: true, vehicles: true, policies: true } },
      },
    });

    // Identity documents are decrypted only to be masked. The full value is
    // never returned by a list or profile endpoint; retrieving it requires a
    // separate, audited support action.
    return {
      ...profile,
      nationalIdNo: this.crypto.mask(this.crypto.decrypt(profile.nationalIdNo)),
      passportNo: this.crypto.mask(this.crypto.decrypt(profile.passportNo)),
    };
  }

  async updateProfile(lawyerId: string, dto: UpdateProfileDto, actorId: string) {
    const before = await this.prisma.lawyerProfile.findUniqueOrThrow({
      where: { id: lawyerId },
    });

    const updated = await this.prisma.lawyerProfile.update({
      where: { id: lawyerId },
      data: {
        fullName: dto.fullName ?? undefined,
        professionalAddress: (dto.professionalAddress as Prisma.InputJsonValue) ?? undefined,
        personalAddress: (dto.personalAddress as Prisma.InputJsonValue) ?? undefined,
        specialization: dto.specialization ?? undefined,
        lawFirmId: dto.lawFirmId ?? undefined,
        // Re-encrypted on every write; never stored as given.
        nationalIdNo: dto.nationalIdNo ? this.crypto.encrypt(dto.nationalIdNo) : undefined,
        passportNo: dto.passportNo ? this.crypto.encrypt(dto.passportNo) : undefined,
      },
    });

    await this.audit.record({
      tenantId: before.tenantId,
      actorId,
      action: 'member.profile_updated',
      entityType: 'LawyerProfile',
      entityId: lawyerId,
      before,
      after: updated,
    });

    return this.getProfile(lawyerId);
  }

  // =========================================================================
  // Bar verification
  // =========================================================================

  /** The Bar administrator's queue, oldest and most overdue first. */
  async verificationQueue(tenantId: string, status: VerificationStatus = 'pending') {
    return this.prisma.barVerification.findMany({
      where: { tenantId, status },
      include: {
        lawyer: {
          select: {
            id: true, barNumber: true, fullName: true, admittedOn: true,
            specialization: true,
            user: { select: { email: true, phoneE164: true } },
          },
        },
      },
      orderBy: [{ slaDueAt: 'asc' }, { submittedAt: 'asc' }],
      take: 100,
    });
  }

  /**
   * Approve or reject a pending verification.
   *
   * Rejection requires a reason: the applicant is told why, and the Bar is
   * accountable for the decision. The lawyer profile and the verification row
   * move together in one transaction — a profile marked verified with no
   * corresponding decision record would be exactly the inconsistency an
   * auditor looks for.
   */
  async decideVerification(
    verificationId: string,
    dto: VerificationDecisionDto,
    actor: { userId: string; tenantId: string },
  ) {
    const verification = await this.prisma.barVerification.findUniqueOrThrow({
      where: { id: verificationId },
      include: { lawyer: { select: { id: true, barNumber: true, userId: true } } },
    });

    if (verification.status !== 'pending') {
      throw new BadRequestException('This verification has already been decided');
    }
    if (dto.decision === 'rejected' && !dto.reason?.trim()) {
      throw new BadRequestException('A reason is required when rejecting a verification');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.barVerification.update({
        where: { id: verificationId },
        data: {
          status: dto.decision,
          decidedAt: new Date(),
          decidedById: actor.userId,
          rejectionReason: dto.reason ?? null,
          registrySnapshot: (dto.registrySnapshot as Prisma.InputJsonValue) ?? undefined,
        },
      });

      await tx.lawyerProfile.update({
        where: { id: verification.lawyerId },
        data: {
          verificationStatus: dto.decision,
          verifiedAt: dto.decision === 'verified' ? new Date() : null,
        },
      });

      await this.prisma.emitEvent(tx, {
        tenantId: actor.tenantId,
        eventType:
          dto.decision === 'verified'
            ? 'lawyer.verification.approved'
            : 'lawyer.verification.rejected',
        aggregateType: 'LawyerProfile',
        aggregateId: verification.lawyerId,
        payload: {
          barNumber: verification.lawyer.barNumber,
          userId: verification.lawyer.userId,
          reason: dto.reason ?? null,
        },
      });

      await this.audit.record(
        {
          tenantId: actor.tenantId,
          actorId: actor.userId,
          action: `bar.verification_${dto.decision}`,
          entityType: 'BarVerification',
          entityId: verificationId,
          before: { status: 'pending' },
          after: { status: dto.decision },
          reason: dto.reason ?? null,
        },
        tx,
      );

      return updated;
    });

    return result;
  }

  /**
   * Gate used by the policy module before a subscription is allowed.
   * Throws rather than returning a boolean so a caller cannot forget to check
   * the result.
   */
  async assertVerified(lawyerId: string): Promise<void> {
    const profile = await this.prisma.lawyerProfile.findUnique({
      where: { id: lawyerId },
      select: { verificationStatus: true },
    });
    if (!profile) throw new NotFoundException('errors.not_found.detail');
    if (profile.verificationStatus !== 'verified') {
      throw new ForbiddenException('onboarding.not_verified');
    }
  }

  // =========================================================================
  // Beneficiaries
  // =========================================================================

  async listBeneficiaries(lawyerId: string) {
    const rows = await this.prisma.beneficiary.findMany({
      where: { lawyerId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((b) => ({
      ...b,
      nationalIdNo: this.crypto.mask(this.crypto.decrypt(b.nationalIdNo)),
    }));
  }

  async addBeneficiary(lawyerId: string, dto: CreateBeneficiaryDto, actorId: string) {
    const lawyer = await this.prisma.lawyerProfile.findUniqueOrThrow({
      where: { id: lawyerId },
      select: { tenantId: true, barNumber: true },
    });

    const ordinal = (await this.prisma.beneficiary.count({ where: { lawyerId } })) + 1;

    const created = await this.prisma.beneficiary.create({
      data: {
        tenantId: lawyer.tenantId,
        lawyerId,
        fullName: dto.fullName.trim(),
        relationship: dto.relationship,
        dateOfBirth: new Date(dto.dateOfBirth),
        nationalIdNo: this.crypto.encrypt(dto.nationalIdNo),
        phoneE164: dto.phone ?? null,
        medicalCoverage: dto.medicalCoverage ?? false,
        cardNumber: beneficiaryCardNumber(lawyer.barNumber, ordinal),
      },
    });

    await this.audit.record({
      tenantId: lawyer.tenantId,
      actorId,
      action: 'member.beneficiary_added',
      entityType: 'Beneficiary',
      entityId: created.id,
      after: { fullName: created.fullName, relationship: created.relationship },
    });

    return { ...created, nationalIdNo: this.crypto.mask(dto.nationalIdNo) };
  }

  async removeBeneficiary(lawyerId: string, beneficiaryId: string, actorId: string) {
    // Scoped by lawyerId as well as id: knowing a beneficiary's id must not
    // be enough to delete somebody else's dependant.
    const beneficiary = await this.prisma.beneficiary.findFirst({
      where: { id: beneficiaryId, lawyerId },
      include: { _count: { select: { policies: true } } },
    });
    if (!beneficiary) throw new NotFoundException('errors.not_found.detail');

    if (beneficiary._count.policies > 0) {
      throw new BadRequestException(
        'This beneficiary is covered by an active policy and cannot be removed',
      );
    }

    await this.prisma.beneficiary.delete({ where: { id: beneficiaryId } });
    await this.audit.record({
      tenantId: beneficiary.tenantId,
      actorId,
      action: 'member.beneficiary_removed',
      entityType: 'Beneficiary',
      entityId: beneficiaryId,
      before: { fullName: beneficiary.fullName },
    });
  }

  // =========================================================================
  // Vehicles
  // =========================================================================

  async listVehicles(lawyerId: string) {
    return this.prisma.vehicle.findMany({ where: { lawyerId }, orderBy: { createdAt: 'asc' } });
  }

  async addVehicle(lawyerId: string, dto: CreateVehicleDto, actorId: string) {
    const lawyer = await this.prisma.lawyerProfile.findUniqueOrThrow({
      where: { id: lawyerId },
      select: { tenantId: true },
    });

    const created = await this.prisma.vehicle.create({
      data: {
        tenantId: lawyer.tenantId,
        lawyerId,
        registrationNumber: dto.registrationNumber.toUpperCase().trim(),
        chassisNumber: dto.chassisNumber.toUpperCase().trim(),
        engineNumber: dto.engineNumber.toUpperCase().trim(),
        make: dto.make.trim(),
        model: dto.model.trim(),
        year: dto.year,
        valueXaf: BigInt(dto.valueXaf),
        seats: dto.seats ?? null,
        usage: dto.usage ?? 'private',
      },
    });

    await this.audit.record({
      tenantId: lawyer.tenantId,
      actorId,
      action: 'member.vehicle_added',
      entityType: 'Vehicle',
      entityId: created.id,
      after: { registrationNumber: created.registrationNumber },
    });

    return created;
  }
}
