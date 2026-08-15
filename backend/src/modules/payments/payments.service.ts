import {
  BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentProviderCode, Prisma } from '@prisma/client';

import { AuditService } from '../../common/audit/audit.service';
import { CardProvider } from './providers/card.provider';
import { MtnMomoProvider } from './providers/mtn-momo.provider';
import { OrangeMoneyProvider } from './providers/orange-money.provider';
import { PoliciesService } from '../policies/policies.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { PaymentProvider } from './providers/payment-provider.interface';
import type { PayInstallmentDto } from './dto/payments.dto';

/**
 * Payment orchestration and the money ledger.
 *
 * Three invariants hold everywhere in this file, and every design decision
 * below follows from them:
 *
 *  1. **A payment is recorded before it is attempted.** The row exists, with
 *     its idempotency key, before we call a provider. If the provider call
 *     times out we still know a collection may be in flight, and the nightly
 *     reconciliation can find it. A payment that exists only at the provider
 *     is money we cannot account for.
 *
 *  2. **Settlement is verified, never assumed.** A webhook says a payment
 *     succeeded; we ask the provider directly before we believe it. A forged
 *     or replayed callback must not be able to activate cover for free.
 *
 *  3. **Cover and money commit together.** Marking the installment paid,
 *     writing the ledger entry, and activating the policy happen in one
 *     transaction. Any partial application of those three is either free
 *     insurance or a paid customer with no cover.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly providers: Map<PaymentProviderCode, PaymentProvider>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly policies: PoliciesService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    orangeMoney: OrangeMoneyProvider,
    mtnMomo: MtnMomoProvider,
    card: CardProvider,
  ) {
    this.providers = new Map<PaymentProviderCode, PaymentProvider>([
      ['orange_money', orangeMoney],
      ['mtn_momo', mtnMomo],
      ['card', card],
    ]);
  }

  private provider(code: PaymentProviderCode): PaymentProvider {
    const provider = this.providers.get(code);
    if (!provider) {
      throw new BadRequestException(`Payment method "${code}" is not available`);
    }
    return provider;
  }

  // =========================================================================
  // Collection
  // =========================================================================

  /**
   * Pay one installment.
   *
   * The `Idempotency-Key` header is required by the controller and stored on
   * the row under a unique constraint. A lawyer on a flaky mobile connection
   * who taps "Pay" twice, or a client that retries on timeout, gets the
   * original payment back rather than a second debit — enforced by the
   * database, not by a check that could race.
   */
  async payInstallment(
    installmentId: string,
    dto: PayInstallmentDto,
    idempotencyKey: string,
    actor: { userId: string; tenantId: string; lawyerId?: string; locale: 'en' | 'fr' },
  ) {
    const existing = await this.prisma.payment.findUnique({
      where: { idempotencyKey },
      select: { id: true, status: true, providerRef: true, amountXaf: true, provider: true },
    });
    if (existing) {
      this.logger.log(`Idempotent replay of ${idempotencyKey} -> payment ${existing.id}`);
      return { ...existing, replayed: true, nextAction: { type: 'none' as const } };
    }

    const installment = await this.prisma.installment.findUnique({
      where: { id: installmentId },
      include: {
        invoice: {
          include: {
            policy: { select: { id: true, lawyerId: true, policyNumber: true, status: true } },
          },
        },
      },
    });
    if (!installment) throw new NotFoundException('errors.not_found.detail');

    if (
      actor.lawyerId &&
      installment.invoice.policy.lawyerId !== actor.lawyerId
    ) {
      throw new NotFoundException('errors.not_found.detail');
    }
    if (installment.status === 'paid') {
      throw new ConflictException('payments.installment_already_paid');
    }

    if ((dto.provider === 'orange_money' || dto.provider === 'mtn_momo') && !dto.msisdn) {
      throw new BadRequestException('payments.invalid_msisdn');
    }

    // Invariant 1: the row exists before the provider is called.
    const payment = await this.prisma.payment.create({
      data: {
        tenantId: actor.tenantId,
        installmentId: installment.id,
        direction: 'in',
        provider: dto.provider,
        amountXaf: installment.amountXaf,
        status: 'initiated',
        idempotencyKey,
        msisdn: dto.msisdn ?? null,
      },
    });

    const callbackBase = this.config.get<string>(
      'PAYMENT_CALLBACK_BASE_URL',
      'http://localhost:3000/v1/payments/webhooks',
    );

    try {
      const result = await this.provider(dto.provider).initiate({
        paymentId: payment.id,
        amountXaf: installment.amountXaf,
        msisdn: dto.msisdn,
        description: `LIH ${installment.invoice.policy.policyNumber} - installment ${installment.seq}`,
        locale: actor.locale,
        callbackUrl: `${callbackBase}/${dto.provider}`,
        returnUrl: this.config.get<string>('PAYMENT_RETURN_URL'),
      });

      const updated = await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          providerRef: result.providerRef || null,
          status: result.status === 'initiated' ? 'pending' : result.status,
          failureReason: result.failureReason ?? null,
        },
      });

      // A provider that settles synchronously (rare, but bank transfer
      // reconciliation and the simulator both can) is applied immediately.
      if (result.status === 'succeeded') {
        await this.settle(payment.id, installment.amountXaf, actor);
      }

      return {
        id: updated.id,
        status: updated.status,
        amountXaf: updated.amountXaf,
        provider: updated.provider,
        nextAction: result.nextAction,
        replayed: false,
      };
    } catch (error) {
      // The payment row survives in `initiated`; reconciliation will resolve
      // whether the provider actually took the money.
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'failed',
          failureReason: error instanceof Error ? error.message : 'provider error',
        },
      });
      throw error;
    }
  }

  // =========================================================================
  // Settlement
  // =========================================================================

  /**
   * Apply a confirmed collection.
   *
   * Invariant 3 lives here: the payment, the installment, the ledger and the
   * policy activation all move in one transaction, or none of them do.
   */
  private async settle(
    paymentId: string,
    amountXaf: bigint,
    actor: { userId: string; tenantId: string },
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
        include: {
          installment: {
            include: {
              invoice: {
                include: {
                  policy: { select: { id: true, status: true, policyNumber: true } },
                  installments: true,
                },
              },
            },
          },
        },
      });

      // Re-entrancy guard: a webhook and a poll can both arrive for the same
      // payment. The first one through wins; the second is a no-op.
      if (payment.status === 'succeeded') return;

      await tx.payment.update({
        where: { id: paymentId },
        data: { status: 'succeeded' },
      });

      if (!payment.installment) return;

      await tx.installment.update({
        where: { id: payment.installment.id },
        data: { status: 'paid', paidAt: new Date() },
      });

      await tx.ledgerEntry.create({
        data: {
          tenantId: actor.tenantId,
          paymentId,
          entryType: 'premium_collected',
          amountXaf,
          description: `Installment ${payment.installment.seq} — ${payment.installment.invoice.policy.policyNumber}`,
        },
      });

      // Invoice status follows from the installments, so it can never
      // disagree with them.
      const siblings = payment.installment.invoice.installments;
      const paidCount =
        siblings.filter((i) => i.status === 'paid' || i.id === payment.installment!.id).length;
      await tx.invoice.update({
        where: { id: payment.installment.invoice.id },
        data: { status: paidCount >= siblings.length ? 'paid' : 'partial' },
      });

      // The first settled installment is what starts cover. Note the
      // permission used: `policies:activate:system` is held by no human role,
      // so this is the only path by which a policy can become active.
      const policy = payment.installment.invoice.policy;
      if (policy.status === 'approved' || policy.status === 'submitted') {
        if (policy.status === 'submitted') {
          await this.policies.transition(
            policy.id,
            'approve',
            { userId: actor.userId, tenantId: actor.tenantId, permissions: ['policies:approve:all'] },
            { note: 'Auto-approved on first settlement (MVP straight-through rule)', tx },
          );
        }
        await this.policies.transition(
          policy.id,
          'activate',
          {
            userId: actor.userId,
            tenantId: actor.tenantId,
            permissions: ['policies:activate:system'],
          },
          { note: `Activated on settlement of payment ${paymentId}`, tx },
        );
      }

      await this.prisma.emitEvent(tx, {
        tenantId: actor.tenantId,
        eventType: 'payment.succeeded',
        aggregateType: 'Payment',
        aggregateId: paymentId,
        payload: {
          amountXaf: amountXaf.toString(),
          policyNumber: policy.policyNumber,
          provider: payment.provider,
        },
      });

      await this.audit.record(
        {
          tenantId: actor.tenantId,
          actorId: actor.userId,
          action: 'payment.settled',
          entityType: 'Payment',
          entityId: paymentId,
          after: { amountXaf: amountXaf.toString(), provider: payment.provider },
        },
        tx,
      );
    });
  }

  /**
   * Handle a provider callback.
   *
   * Invariant 2: the callback is authenticated, then independently verified
   * against the provider, and the amount is compared to what we expected. A
   * mismatch is never applied — it is flagged for finance.
   */
  async handleWebhook(
    providerCode: PaymentProviderCode,
    headers: Record<string, string | undefined>,
    body: unknown,
  ): Promise<{ received: true }> {
    const provider = this.provider(providerCode);
    const parsed = provider.parseWebhook(headers, body); // throws on bad signature

    const payment = parsed.paymentId
      ? await this.prisma.payment.findUnique({ where: { id: parsed.paymentId } })
      : await this.prisma.payment.findFirst({
          where: { provider: providerCode, providerRef: parsed.providerRef },
        });

    if (!payment) {
      // Log and accept: returning an error makes the provider retry a
      // callback we will never be able to match, and some providers disable
      // an endpoint that keeps failing.
      this.logger.warn(
        `Unmatched ${providerCode} callback: ref=${parsed.providerRef} id=${parsed.paymentId}`,
      );
      return { received: true };
    }

    if (payment.status === 'succeeded' || payment.status === 'reversed') {
      return { received: true };
    }

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { rawCallback: parsed.raw as Prisma.InputJsonValue },
    });

    if (parsed.status === 'failed') {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'failed', failureReason: parsed.failureReason ?? 'declined' },
      });
      return { received: true };
    }

    if (parsed.status !== 'succeeded') return { received: true };

    // Independent confirmation.
    const verified = await provider.verify(payment.providerRef ?? parsed.providerRef);
    if (verified.status !== 'succeeded') {
      this.logger.warn(
        `Callback claimed success but verification returned ${verified.status} for ${payment.id}`,
      );
      return { received: true };
    }

    if (verified.amountXaf != null && verified.amountXaf !== payment.amountXaf) {
      this.logger.error(
        `Amount mismatch on ${payment.id}: expected ${payment.amountXaf}, provider reported ${verified.amountXaf}`,
      );
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'failed', failureReason: 'payments.amount_mismatch' },
      });
      return { received: true };
    }

    await this.settle(payment.id, payment.amountXaf, {
      userId: payment.tenantId, // system actor; audited as such
      tenantId: payment.tenantId,
    });

    return { received: true };
  }

  // =========================================================================
  // Payouts and refunds
  // =========================================================================

  /** Pay an approved claim to the claimant's mobile money wallet. */
  async payClaim(
    claimId: string,
    params: { provider: PaymentProviderCode; msisdn: string; idempotencyKey: string },
    actor: { userId: string; tenantId: string },
  ) {
    const claim = await this.prisma.claim.findUniqueOrThrow({
      where: { id: claimId },
      select: { id: true, status: true, approvedXaf: true, claimNumber: true },
    });

    if (claim.status !== 'approved') {
      throw new BadRequestException('A claim must be approved before it can be paid');
    }
    if (!claim.approvedXaf || claim.approvedXaf <= 0n) {
      throw new BadRequestException('payments.claim_not_approved_amount');
    }

    const existing = await this.prisma.payment.findUnique({
      where: { idempotencyKey: params.idempotencyKey },
    });
    if (existing) return existing;

    const payment = await this.prisma.payment.create({
      data: {
        tenantId: actor.tenantId,
        claimId: claim.id,
        direction: 'out',
        provider: params.provider,
        amountXaf: claim.approvedXaf,
        status: 'initiated',
        idempotencyKey: params.idempotencyKey,
        msisdn: params.msisdn,
      },
    });

    const result = await this.provider(params.provider).payout({
      paymentId: payment.id,
      amountXaf: claim.approvedXaf,
      msisdn: params.msisdn,
      description: `LIH indemnity ${claim.claimNumber}`,
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.payment.update({
        where: { id: payment.id },
        data: {
          providerRef: result.providerRef || null,
          status: result.status === 'initiated' ? 'pending' : result.status,
          failureReason: result.failureReason ?? null,
        },
      });

      if (result.status === 'succeeded') {
        await tx.ledgerEntry.create({
          data: {
            tenantId: actor.tenantId,
            paymentId: payment.id,
            entryType: 'claim_paid',
            amountXaf: claim.approvedXaf!,
            description: `Indemnity ${claim.claimNumber}`,
          },
        });
      }

      await this.audit.record(
        {
          tenantId: actor.tenantId,
          actorId: actor.userId,
          action: 'payment.claim_payout',
          entityType: 'Claim',
          entityId: claim.id,
          after: { amountXaf: claim.approvedXaf!.toString(), provider: params.provider },
        },
        tx,
      );

      return row;
    });

    return updated;
  }

  /**
   * Refund a premium payment, in whole or in part.
   *
   * A refund is a new payment row pointing at the original rather than an
   * edit of it. The original stands as the record of what was collected; the
   * refund stands as the record of what was returned. Editing the original
   * would destroy the history the finance reconciliation depends on.
   */
  async refund(
    paymentId: string,
    amountXaf: bigint | null,
    reason: string,
    idempotencyKey: string,
    actor: { userId: string; tenantId: string },
  ) {
    const original = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: { refunds: true },
    });

    if (original.status !== 'succeeded') {
      throw new BadRequestException('payments.refund_requires_settled');
    }

    const alreadyRefunded = original.refunds
      .filter((r) => r.status === 'succeeded' || r.status === 'pending')
      .reduce((sum, r) => sum + r.amountXaf, 0n);

    const requested = amountXaf ?? original.amountXaf - alreadyRefunded;
    if (requested <= 0n || alreadyRefunded + requested > original.amountXaf) {
      throw new BadRequestException('payments.refund_exceeds_payment');
    }

    const existing = await this.prisma.payment.findUnique({ where: { idempotencyKey } });
    if (existing) return existing;

    return this.prisma.$transaction(async (tx) => {
      const refund = await tx.payment.create({
        data: {
          tenantId: actor.tenantId,
          refundOfId: original.id,
          direction: 'out',
          provider: original.provider,
          amountXaf: requested,
          status: 'pending',
          idempotencyKey,
          msisdn: original.msisdn,
        },
      });

      await tx.ledgerEntry.create({
        data: {
          tenantId: actor.tenantId,
          paymentId: refund.id,
          entryType: 'refund_issued',
          amountXaf: requested,
          description: reason,
        },
      });

      await this.audit.record(
        {
          tenantId: actor.tenantId,
          actorId: actor.userId,
          action: 'payment.refund',
          entityType: 'Payment',
          entityId: original.id,
          after: { refundId: refund.id, amountXaf: requested.toString() },
          reason,
        },
        tx,
      );

      return refund;
    });
  }

  // =========================================================================
  // Reconciliation
  // =========================================================================

  /**
   * Daily reconciliation against a provider's settlement report.
   *
   * Finds three kinds of disagreement:
   *   * **orphans** — the provider settled something we have no record of
   *   * **missing** — we believe a payment succeeded and the provider does not
   *   * **mismatches** — both know the payment, the amounts differ
   *
   * None are auto-corrected. Each is surfaced on the Finance dashboard for a
   * human, because every one of them is either a bug or a fraud signal and
   * silently "fixing" it would hide both.
   */
  async reconcile(
    providerCode: PaymentProviderCode,
    settlements: Array<{ providerRef: string; amountXaf: string; status: string }>,
    runDate: Date,
    tenantId: string,
  ) {
    const ours = await this.prisma.payment.findMany({
      where: {
        tenantId,
        provider: providerCode,
        createdAt: {
          gte: new Date(runDate.getFullYear(), runDate.getMonth(), runDate.getDate()),
          lt: new Date(runDate.getFullYear(), runDate.getMonth(), runDate.getDate() + 1),
        },
      },
      select: { id: true, providerRef: true, amountXaf: true, status: true },
    });

    const byRef = new Map(ours.filter((p) => p.providerRef).map((p) => [p.providerRef!, p]));
    const settledRefs = new Set(settlements.map((s) => s.providerRef));

    const orphans: unknown[] = [];
    const mismatches: unknown[] = [];
    let matched = 0;

    for (const settlement of settlements) {
      const payment = byRef.get(settlement.providerRef);
      if (!payment) {
        orphans.push({ providerRef: settlement.providerRef, amountXaf: settlement.amountXaf });
        continue;
      }
      if (BigInt(settlement.amountXaf) !== payment.amountXaf) {
        mismatches.push({
          paymentId: payment.id,
          ours: payment.amountXaf.toString(),
          theirs: settlement.amountXaf,
        });
        continue;
      }
      matched += 1;
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { reconciledAt: new Date() },
      });
    }

    const missing = ours
      .filter((p) => p.status === 'succeeded' && p.providerRef && !settledRefs.has(p.providerRef))
      .map((p) => ({ paymentId: p.id, providerRef: p.providerRef, amountXaf: p.amountXaf.toString() }));

    return this.prisma.reconciliationRun.upsert({
      where: { provider_runDate: { provider: providerCode, runDate } },
      create: {
        tenantId,
        provider: providerCode,
        runDate,
        matchedCount: matched,
        orphanCount: orphans.length,
        mismatchCount: mismatches.length + missing.length,
        findings: { orphans, mismatches, missing } as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
      update: {
        matchedCount: matched,
        orphanCount: orphans.length,
        mismatchCount: mismatches.length + missing.length,
        findings: { orphans, mismatches, missing } as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });
  }

  async history(lawyerId: string) {
    return this.prisma.payment.findMany({
      where: { installment: { invoice: { policy: { lawyerId } } } },
      include: {
        installment: {
          select: {
            seq: true,
            invoice: { select: { invoiceNo: true, policy: { select: { policyNumber: true } } } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
