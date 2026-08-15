import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  InitiateParams, InitiateResult, PaymentProvider, PayoutParams, VerifyResult,
  WebhookParseResult,
} from './payment-provider.interface';

/**
 * Visa and Mastercard, through the CinetPay aggregator.
 *
 * The single most important property of this integration: **card data never
 * touches our servers**. The customer is redirected to CinetPay's hosted
 * checkout, enters their card there, and returns with a token. That keeps the
 * PCI-DSS burden with the aggregator, which is the difference between an
 * annual SAQ-A questionnaire and a full PCI audit of our infrastructure.
 *
 * Nothing in this class should ever accept a PAN, a CVV or an expiry date. If
 * a future change appears to need one, the answer is a different aggregator
 * feature, not a field on our side.
 */
@Injectable()
export class CardProvider implements PaymentProvider {
  readonly code = 'card' as const;
  private readonly logger = new Logger(CardProvider.name);

  constructor(private readonly config: ConfigService) {}

  private get configured(): boolean {
    return Boolean(this.config.get('CINETPAY_API_KEY') && this.config.get('CINETPAY_SITE_ID'));
  }

  private get baseUrl(): string {
    return this.config.get<string>('CINETPAY_BASE_URL', 'https://api-checkout.cinetpay.com/v2');
  }

  async initiate(params: InitiateParams): Promise<InitiateResult> {
    if (!this.configured) {
      this.logger.warn('CinetPay is not configured — simulating a card checkout');
      return {
        providerRef: `sim-card-${params.paymentId}`,
        status: 'pending',
        nextAction: {
          type: 'redirect',
          url: `${params.returnUrl ?? 'http://localhost:3001'}?simulated=1&payment=${params.paymentId}`,
        },
      };
    }

    const response = await fetch(`${this.baseUrl}/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apikey: this.config.getOrThrow('CINETPAY_API_KEY'),
        site_id: this.config.getOrThrow('CINETPAY_SITE_ID'),
        transaction_id: params.paymentId,
        amount: Number(params.amountXaf), // whole francs
        currency: 'XAF',
        description: params.description.slice(0, 255),
        notify_url: params.callbackUrl,
        return_url: params.returnUrl,
        channels: 'CREDIT_CARD',
        lang: params.locale.toUpperCase(),
      }),
    });

    if (!response.ok) throw new ServiceUnavailableException('payments.provider_unavailable');

    const body = (await response.json()) as {
      code: string;
      data?: { payment_token: string; payment_url: string };
      message?: string;
    };

    if (body.code !== '201' || !body.data) {
      return {
        providerRef: '',
        status: 'failed',
        nextAction: { type: 'none' },
        failureReason: body.message ?? 'Card checkout could not be created',
      };
    }

    return {
      providerRef: body.data.payment_token,
      status: 'pending',
      nextAction: { type: 'redirect', url: body.data.payment_url },
    };
  }

  async verify(providerRef: string): Promise<VerifyResult> {
    if (!this.configured) return { providerRef, status: 'succeeded' };

    const response = await fetch(`${this.baseUrl}/payment/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apikey: this.config.getOrThrow('CINETPAY_API_KEY'),
        site_id: this.config.getOrThrow('CINETPAY_SITE_ID'),
        transaction_id: providerRef,
      }),
    });

    if (!response.ok) throw new ServiceUnavailableException('payments.provider_unavailable');

    const body = (await response.json()) as {
      code: string;
      data?: { status: string; amount: string };
      message?: string;
    };

    const status =
      body.data?.status === 'ACCEPTED'
        ? 'succeeded'
        : ['REFUSED', 'CANCELED', 'EXPIRED'].includes(body.data?.status ?? '')
          ? 'failed'
          : 'pending';

    return {
      providerRef,
      status,
      amountXaf: body.data?.amount ? BigInt(body.data.amount.split('.')[0]!) : undefined,
      failureReason: body.message,
      raw: body,
    };
  }

  async payout(): Promise<InitiateResult> {
    // Card refunds go back to the originating card through the aggregator's
    // refund endpoint, not through a generic payout. Refunds are handled by
    // PaymentsService.refund(), which calls that endpoint directly.
    throw new ServiceUnavailableException(
      'Card payouts are not supported; use a refund against the original payment',
    );
  }

  parseWebhook(
    headers: Record<string, string | undefined>,
    body: unknown,
  ): WebhookParseResult {
    const secret = this.config.get<string>('CINETPAY_WEBHOOK_SECRET');

    if (secret) {
      const signature = headers['x-token'] ?? headers['x-signature'];
      const expected = createHmac('sha256', secret)
        .update(typeof body === 'string' ? body : JSON.stringify(body))
        .digest('hex');
      const provided = Buffer.from(signature ?? '');
      const computed = Buffer.from(expected);
      if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
        throw new Error('payments.webhook_signature_invalid');
      }
    }

    const payload = (typeof body === 'string' ? JSON.parse(body) : body) as {
      cpm_trans_id?: string;
      cpm_site_id?: string;
      cpm_amount?: string;
      cpm_result?: string;
      payment_token?: string;
    };

    return {
      paymentId: payload.cpm_trans_id ?? null,
      providerRef: payload.payment_token ?? payload.cpm_trans_id ?? '',
      // CinetPay signals success with result code "00"; anything else is a
      // decline. We never infer success from the absence of an error.
      status: payload.cpm_result === '00' ? 'succeeded' : 'failed',
      amountXaf: payload.cpm_amount ? BigInt(payload.cpm_amount.split('.')[0]!) : null,
      raw: payload,
    };
  }
}
