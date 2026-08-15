import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  InitiateParams, InitiateResult, PaymentProvider, PayoutParams, VerifyResult,
  WebhookParseResult,
} from './payment-provider.interface';

/**
 * Orange Money Cameroon — Web Payment API.
 *
 * Flow: exchange client credentials for a bearer token, create a payment and
 * receive a `payment_url` plus a `pay_token`. The customer confirms on their
 * handset (or in the Orange page), and settlement comes back by callback,
 * which we then confirm with a status call before recording it as settled.
 */
@Injectable()
export class OrangeMoneyProvider implements PaymentProvider {
  readonly code = 'orange_money' as const;
  private readonly logger = new Logger(OrangeMoneyProvider.name);

  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: ConfigService) {}

  private get configured(): boolean {
    return Boolean(
      this.config.get('ORANGE_MONEY_CLIENT_ID') &&
        this.config.get('ORANGE_MONEY_CLIENT_SECRET') &&
        this.config.get('ORANGE_MONEY_MERCHANT_KEY'),
    );
  }

  private get baseUrl(): string {
    return this.config.get<string>(
      'ORANGE_MONEY_BASE_URL',
      'https://api.orange.com/orange-money-webpay/cm/v1',
    );
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;

    const id = this.config.getOrThrow<string>('ORANGE_MONEY_CLIENT_ID');
    const secret = this.config.getOrThrow<string>('ORANGE_MONEY_CLIENT_SECRET');
    const basic = Buffer.from(`${id}:${secret}`).toString('base64');

    const response = await fetch('https://api.orange.com/oauth/v3/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      this.logger.error(`Orange Money token request failed: ${response.status}`);
      throw new ServiceUnavailableException('payments.provider_unavailable');
    }

    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return this.token.value;
  }

  async initiate(params: InitiateParams): Promise<InitiateResult> {
    if (!this.configured) return this.simulate(params);

    try {
      const response = await fetch(`${this.baseUrl}/webpayment`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await this.accessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          merchant_key: this.config.getOrThrow('ORANGE_MONEY_MERCHANT_KEY'),
          currency: 'XAF',
          order_id: params.paymentId,
          // Whole francs — Orange rejects a decimal amount for XAF.
          amount: Number(params.amountXaf),
          return_url: params.returnUrl ?? params.callbackUrl,
          cancel_url: params.returnUrl ?? params.callbackUrl,
          notif_url: params.callbackUrl,
          lang: params.locale,
          reference: params.description.slice(0, 40),
        }),
      });

      if (!response.ok) {
        const detail = await response.text();
        this.logger.warn(`Orange Money rejected the payment (${response.status}): ${detail}`);
        return {
          providerRef: '',
          status: 'failed',
          nextAction: { type: 'none' },
          failureReason: `Orange Money rejected the request (${response.status})`,
        };
      }

      const body = (await response.json()) as {
        pay_token: string;
        payment_url: string;
        notif_token: string;
      };

      return {
        providerRef: body.pay_token,
        status: 'pending',
        nextAction: { type: 'redirect', url: body.payment_url },
      };
    } catch (error) {
      this.logger.error('Orange Money initiate failed', error instanceof Error ? error.stack : error);
      throw new ServiceUnavailableException('payments.provider_unavailable');
    }
  }

  async verify(providerRef: string): Promise<VerifyResult> {
    if (!this.configured) return { providerRef, status: 'succeeded' };

    const response = await fetch(`${this.baseUrl}/transactionstatus`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        order_id: providerRef,
        amount: 0,
        pay_token: providerRef,
      }),
    });

    if (!response.ok) throw new ServiceUnavailableException('payments.provider_unavailable');

    const body = (await response.json()) as { status: string; txnid?: string; amount?: number };
    const status =
      body.status === 'SUCCESS'
        ? 'succeeded'
        : ['FAILED', 'EXPIRED', 'CANCELLED'].includes(body.status)
          ? 'failed'
          : 'pending';

    return {
      providerRef,
      status,
      amountXaf: body.amount != null ? BigInt(Math.round(body.amount)) : undefined,
      raw: body,
    };
  }

  async payout(params: PayoutParams): Promise<InitiateResult> {
    // Claim indemnities and refunds use the Orange Money transfer API, which
    // is provisioned separately from collections.
    if (!this.configured) {
      return {
        providerRef: `sim-om-payout-${params.paymentId}`,
        status: 'succeeded',
        nextAction: { type: 'none' },
      };
    }

    const response = await fetch(`${this.baseUrl}/cashout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        merchant_key: this.config.getOrThrow('ORANGE_MONEY_MERCHANT_KEY'),
        currency: 'XAF',
        order_id: params.paymentId,
        amount: Number(params.amountXaf),
        subscriber_msisdn: params.msisdn.replace(/^\+/, ''),
        reference: params.description.slice(0, 40),
      }),
    });

    if (!response.ok) {
      return {
        providerRef: '',
        status: 'failed',
        nextAction: { type: 'none' },
        failureReason: `Orange Money payout rejected (${response.status})`,
      };
    }

    const body = (await response.json()) as { pay_token?: string };
    return {
      providerRef: body.pay_token ?? params.paymentId,
      status: 'pending',
      nextAction: { type: 'none' },
    };
  }

  parseWebhook(
    headers: Record<string, string | undefined>,
    body: unknown,
  ): WebhookParseResult {
    const secret = this.config.get<string>('ORANGE_MONEY_WEBHOOK_SECRET');

    if (secret) {
      const signature = headers['x-orange-signature'] ?? headers['x-signature'];
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
      order_id?: string;
      pay_token?: string;
      status?: string;
      amount?: number;
      txnid?: string;
    };

    return {
      paymentId: payload.order_id ?? null,
      providerRef: payload.pay_token ?? payload.txnid ?? '',
      status:
        payload.status === 'SUCCESS'
          ? 'succeeded'
          : ['FAILED', 'EXPIRED', 'CANCELLED'].includes(payload.status ?? '')
            ? 'failed'
            : 'pending',
      amountXaf: payload.amount != null ? BigInt(Math.round(payload.amount)) : null,
      raw: payload,
    };
  }

  private simulate(params: InitiateParams): InitiateResult {
    this.logger.warn(
      `Orange Money is not configured — simulating a collection of ${params.amountXaf} XAF`,
    );
    return {
      providerRef: `sim-om-${params.paymentId}`,
      status: 'pending',
      nextAction: {
        type: 'redirect',
        url: `${params.returnUrl ?? 'http://localhost:3001'}?simulated=1&payment=${params.paymentId}`,
      },
    };
  }
}
