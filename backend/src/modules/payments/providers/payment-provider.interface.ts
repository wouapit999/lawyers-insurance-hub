/**
 * The one interface every payment rail implements.
 *
 * Orange Money, MTN MoMo, cards and bank transfer behave very differently —
 * one pushes a USSD prompt to a handset, another redirects a browser, a third
 * arrives as a line on a bank statement the next morning. Everything above
 * this interface is written against the common shape, which is why adding a
 * rail (or replacing CinetPay with Flutterwave) touches one file and no
 * business logic.
 *
 * Money is bigint XAF throughout. Providers that speak in decimal strings
 * convert at their own boundary and nowhere else.
 */

export type ProviderCode = 'orange_money' | 'mtn_momo' | 'card' | 'bank_transfer';

export interface InitiateParams {
  /** Our payment id — passed to the provider as the external reference. */
  paymentId: string;
  amountXaf: bigint;
  /** Payer's mobile number in E.164. Required for mobile money. */
  msisdn?: string;
  /** Shown on the customer's statement / USSD prompt. */
  description: string;
  locale: 'en' | 'fr';
  returnUrl?: string;
  callbackUrl: string;
}

export interface InitiateResult {
  /** The provider's own transaction reference. */
  providerRef: string;
  status: 'initiated' | 'pending' | 'succeeded' | 'failed';
  /**
   * What the client must do next. Mobile money asks the user to confirm a
   * prompt on their handset; cards need a redirect.
   */
  nextAction:
    | { type: 'ussd_prompt'; message: string }
    | { type: 'redirect'; url: string }
    | { type: 'bank_reference'; reference: string; accountName: string }
    | { type: 'none' };
  failureReason?: string;
}

export interface VerifyResult {
  providerRef: string;
  status: 'pending' | 'succeeded' | 'failed';
  amountXaf?: bigint;
  failureReason?: string;
  raw?: unknown;
}

export interface PayoutParams {
  paymentId: string;
  amountXaf: bigint;
  msisdn: string;
  description: string;
}

export interface WebhookParseResult {
  /** Our payment id, recovered from the provider's payload. */
  paymentId: string | null;
  providerRef: string;
  status: 'pending' | 'succeeded' | 'failed';
  amountXaf: bigint | null;
  failureReason?: string;
  raw: unknown;
}

export interface PaymentProvider {
  readonly code: ProviderCode;

  /** Start a collection. */
  initiate(params: InitiateParams): Promise<InitiateResult>;

  /**
   * Ask the provider what actually happened.
   *
   * Webhooks get lost, arrive out of order and occasionally lie about
   * amounts. Verification against the provider is the source of truth before
   * any payment is marked succeeded — a webhook alone never settles money.
   */
  verify(providerRef: string): Promise<VerifyResult>;

  /** Send money out: claim indemnities and refunds. */
  payout(params: PayoutParams): Promise<InitiateResult>;

  /**
   * Authenticate and decode a callback.
   * @throws when the signature does not verify — an unauthenticated callback
   *         claiming a payment succeeded is the most obvious attack on a
   *         payment system, so this must never be lenient.
   */
  parseWebhook(headers: Record<string, string | undefined>, body: unknown): WebhookParseResult;
}

export const PAYMENT_PROVIDERS = 'PAYMENT_PROVIDERS';
