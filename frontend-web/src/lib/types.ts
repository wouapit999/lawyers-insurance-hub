/**
 * API response shapes.
 *
 * Hand-written for now. Once the OpenAPI document is published from the
 * running API these should be generated from it, so the client cannot drift
 * from the server — that is what packages/contracts is for in the plan.
 *
 * Money is always a decimal STRING here, never a number. The API sends
 * `"285000"` precisely so a JavaScript client cannot parse it into a float,
 * and these types keep that discipline visible at every call site.
 */

/** RFC 9457 problem+json, already localised by the API. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  /** Quote this to support — it matches the server log line. */
  requestId: string;
  /** Field-level validation messages, keyed by field name. */
  errors?: Record<string, string[]>;
}

export type Locale = 'en' | 'fr';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
}

export type LoginResult = TokenPair | MfaChallenge;

export function isMfaChallenge(result: LoginResult): result is MfaChallenge {
  return 'mfaRequired' in result;
}

export interface Profile {
  userId: string;
  email: string;
  locale: Locale;
  roles: string[];
  permissions: string[];
  lawyerId?: string;
  verificationStatus?: 'pending' | 'verified' | 'rejected';
  mfaEnabled: boolean;
  emailVerified: boolean;
  phoneVerified: boolean;
}

export interface Plan {
  code: string;
  name: string;
  /** Whole XAF francs as a decimal string. */
  basePremiumXaf: string;
  installmentOptions: number[];
  coverage?: Record<string, unknown>;
}

export interface Product {
  code: string;
  name: string;
  description: string | null;
  plans: Plan[];
}

export interface QuoteBreakdownLine {
  label: string;
  kind: string;
  multiplier?: number;
  deltaXaf?: string;
  runningXaf: string;
}

export interface Quote {
  id: string;
  planCode: string;
  productCode: string;
  planName: string;
  premiumXaf: string;
  installments: number;
  /** Each installment amount; sums exactly to premiumXaf. */
  schedule: string[];
  breakdown: QuoteBreakdownLine[];
  validUntil: string;
}

export type PolicyStatus =
  | 'draft' | 'submitted' | 'under_review' | 'approved'
  | 'active' | 'suspended' | 'expired' | 'cancelled' | 'renewed';

export interface Policy {
  id: string;
  policyNumber: string;
  status: PolicyStatus;
  premiumXaf: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export type ClaimStatus =
  | 'submitted' | 'investigation' | 'assessment'
  | 'approved' | 'rejected' | 'payment' | 'closed';

export type SlaState = 'none' | 'on_track' | 'due_soon' | 'breached';

export interface Claim {
  id: string;
  claimNumber: string;
  status: ClaimStatus;
  incidentAt: string;
  claimedXaf: string | null;
  approvedXaf: string | null;
  slaDueAt: string | null;
  sla?: SlaState;
}

export interface PaymentIntent {
  id: string;
  status: 'initiated' | 'pending' | 'succeeded' | 'failed' | 'reversed';
  amountXaf: string;
  provider: string;
  /** What the client must do next to complete the payment. */
  nextAction:
    | { type: 'ussd_prompt'; message: string }
    | { type: 'redirect'; url: string }
    | { type: 'bank_reference'; reference: string; accountName: string }
    | { type: 'none' };
  replayed: boolean;
}
