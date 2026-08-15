import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import type {
  InitiateParams, InitiateResult, PaymentProvider, PayoutParams, VerifyResult,
  WebhookParseResult,
} from './payment-provider.interface';

/**
 * MTN Mobile Money — Collections and Disbursements (MoMo Open API).
 *
 * Flow: `requestToPay` returns immediately with our own X-Reference-Id as the
 * transaction reference; the subscriber then approves a USSD prompt on their
 * handset. Settlement arrives later by callback, and we confirm it by polling
 * `requestToPay/{ref}` — MTN's callbacks are not reliably delivered, and a
 * premium marked paid on a callback we never verified is an unbacked policy.
 *
 * Access tokens live one hour and are cached in-process; a token request on
 * every payment would double the latency of the checkout.
 */
@Injectable()
export class MtnMomoProvider implements PaymentProvider {
  readonly code = 'mtn_momo' as const;
  private readonly logger = new Logger(MtnMomoProvider.name);

  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: ConfigService) {}

  private get configured(): boolean {
    return Boolean(
      this.config.get('MTN_MOMO_SUBSCRIPTION_KEY') &&
        this.config.get('MTN_MOMO_API_USER') &&
        this.config.get('MTN_MOMO_API_KEY'),
    );
  }

  private get baseUrl(): string {
    return this.config.get<string>('MTN_MOMO_BASE_URL', 'https://sandbox.momodeveloper.mtn.com');
  }

  /**
   * MoMo wants a national subscriber number without the country code.
   * Sending E.164 straight through is the single most common integration
   * mistake and produces an opaque "payer not found".
   */
  private toSubscriber(msisdn: string): string {
    return msisdn.replace(/^\+?237/, '').replace(/\D/g, '');
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.value;
    }

    const user = this.config.getOrThrow<string>('MTN_MOMO_API_USER');
    const key = this.config.getOrThrow<string>('MTN_MOMO_API_KEY');
    const basic = Buffer.from(`${user}:${key}`).toString('base64');

    const response = await fetch(`${this.baseUrl}/collection/token/`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Ocp-Apim-Subscription-Key': this.config.getOrThrow<string>('MTN_MOMO_SUBSCRIPTION_KEY'),
      },
    });

    if (!response.ok) {
      this.logger.error(`MoMo token request failed: ${response.status}`);
      throw new ServiceUnavailableException('payments.provider_unavailable');
    }

    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    };
    return this.token.value;
  }

  async initiate(params: InitiateParams): Promise<InitiateResult> {
    if (!params.msisdn) {
      return {
        providerRef: '',
        status: 'failed',
        nextAction: { type: 'none' },
        failureReason: 'payments.invalid_msisdn',
      };
    }

    // Without credentials (local development, CI) the adapter simulates the
    // rail rather than failing, so the whole checkout flow stays testable
    // end to end without MTN's sandbox.
    if (!this.configured) return this.simulate(params);

    // MoMo uses OUR uuid as the transaction reference, which makes the call
    // naturally idempotent: replaying the same reference does not create a
    // second collection.
    const reference = randomUUID();

    try {
      const response = await fetch(`${this.baseUrl}/collection/v1_0/requesttopay`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await this.accessToken()}`,
          'X-Reference-Id': reference,
          'X-Target-Environment': this.config.get('MTN_MOMO_TARGET_ENVIRONMENT', 'sandbox'),
          'Ocp-Apim-Subscription-Key': this.config.getOrThrow('MTN_MOMO_SUBSCRIPTION_KEY'),
          'X-Callback-Url': params.callbackUrl,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          // XAF has no minor unit, so the whole-franc integer is the amount.
          amount: params.amountXaf.toString(),
          currency: 'XAF',
          externalId: params.paymentId,
          payer: { partyIdType: 'MSISDN', partyId: this.toSubscriber(params.msisdn) },
          payerMessage: params.description.slice(0, 160),
          payeeNote: `LIH ${params.paymentId}`,
        }),
      });

      if (response.status !== 202) {
        const detail = await response.text();
        this.logger.warn(`MoMo requestToPay rejected (${response.status}): ${detail}`);
        return {
          providerRef: reference,
          status: 'failed',
          nextAction: { type: 'none' },
          failureReason: `MoMo rejected the request (${response.status})`,
        };
      }

      return {
        providerRef: reference,
        status: 'pending',
        nextAction: {
          type: 'ussd_prompt',
          message:
            params.locale === 'fr'
              ? 'Confirmez le paiement sur votre téléphone (menu MTN MoMo).'
              : 'Confirm the payment on your handset (MTN MoMo prompt).',
        },
      };
    } catch (error) {
      this.logger.error('MoMo requestToPay failed', error instanceof Error ? error.stack : error);
      throw new ServiceUnavailableException('payments.provider_unavailable');
    }
  }

  async verify(providerRef: string): Promise<VerifyResult> {
    if (!this.configured) {
      return { providerRef, status: 'succeeded', amountXaf: undefined };
    }

    const response = await fetch(`${this.baseUrl}/collection/v1_0/requesttopay/${providerRef}`, {
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        'X-Target-Environment': this.config.get('MTN_MOMO_TARGET_ENVIRONMENT', 'sandbox'),
        'Ocp-Apim-Subscription-Key': this.config.getOrThrow('MTN_MOMO_SUBSCRIPTION_KEY'),
      },
    });

    if (!response.ok) {
      throw new ServiceUnavailableException('payments.provider_unavailable');
    }

    const body = (await response.json()) as {
      status: 'PENDING' | 'SUCCESSFUL' | 'FAILED';
      amount: string;
      reason?: string;
    };

    const status =
      body.status === 'SUCCESSFUL' ? 'succeeded' : body.status === 'FAILED' ? 'failed' : 'pending';

    return {
      providerRef,
      status,
      amountXaf: body.amount ? BigInt(body.amount.split('.')[0]!) : undefined,
      failureReason: body.reason,
      raw: body,
    };
  }

  async payout(params: PayoutParams): Promise<InitiateResult> {
    if (!this.configured) {
      return { providerRef: `sim-payout-${params.paymentId}`, status: 'succeeded', nextAction: { type: 'none' } };
    }

    const reference = randomUUID();
    const response = await fetch(`${this.baseUrl}/disbursement/v1_0/transfer`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        'X-Reference-Id': reference,
        'X-Target-Environment': this.config.get('MTN_MOMO_TARGET_ENVIRONMENT', 'sandbox'),
        'Ocp-Apim-Subscription-Key': this.config.getOrThrow('MTN_MOMO_SUBSCRIPTION_KEY'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: params.amountXaf.toString(),
        currency: 'XAF',
        externalId: params.paymentId,
        payee: { partyIdType: 'MSISDN', partyId: this.toSubscriber(params.msisdn) },
        payerMessage: params.description.slice(0, 160),
        payeeNote: `LIH payout ${params.paymentId}`,
      }),
    });

    if (response.status !== 202) {
      return {
        providerRef: reference,
        status: 'failed',
        nextAction: { type: 'none' },
        failureReason: `MoMo disbursement rejected (${response.status})`,
      };
    }
    return { providerRef: reference, status: 'pending', nextAction: { type: 'none' } };
  }

  parseWebhook(
    headers: Record<string, string | undefined>,
    body: unknown,
  ): WebhookParseResult {
    const secret = this.config.get<string>('MTN_MOMO_WEBHOOK_SECRET');

    if (secret) {
      const signature = headers['x-momo-signature'] ?? headers['x-signature'];
      const expected = createHmac('sha256', secret)
        .update(typeof body === 'string' ? body : JSON.stringify(body))
        .digest('hex');

      const provided = Buffer.from(signature ?? '');
      const computed = Buffer.from(expected);
      if (
        provided.length !== computed.length ||
        !timingSafeEqual(provided, computed)
      ) {
        throw new Error('payments.webhook_signature_invalid');
      }
    }

    const payload = (typeof body === 'string' ? JSON.parse(body) : body) as {
      referenceId?: string;
      externalId?: string;
      status?: string;
      amount?: string;
      reason?: string;
    };

    return {
      paymentId: payload.externalId ?? null,
      providerRef: payload.referenceId ?? '',
      status:
        payload.status === 'SUCCESSFUL'
          ? 'succeeded'
          : payload.status === 'FAILED'
            ? 'failed'
            : 'pending',
      amountXaf: payload.amount ? BigInt(payload.amount.split('.')[0]!) : null,
      failureReason: payload.reason,
      raw: payload,
    };
  }

  /** Development stand-in for the rail. Never reached when configured. */
  private simulate(params: InitiateParams): InitiateResult {
    this.logger.warn(
      `MTN MoMo is not configured — simulating a collection of ${params.amountXaf} XAF`,
    );
    return {
      providerRef: `sim-momo-${params.paymentId}`,
      status: 'pending',
      nextAction: {
        type: 'ussd_prompt',
        message:
          params.locale === 'fr'
            ? '[simulation] Confirmez le paiement sur votre téléphone.'
            : '[simulation] Confirm the payment on your handset.',
      },
    };
  }
}
