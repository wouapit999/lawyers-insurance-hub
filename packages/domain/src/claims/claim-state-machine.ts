/**
 * Claims workflow state machine.
 *
 *   submitted -> investigation -> assessment -> approved -> payment -> closed
 *                                            -> rejected -> closed
 *
 * Each transition carries the role-scoped permission that may perform it and
 * the SLA clock it starts. The SLA hours are the operational promise from the
 * blueprint (median decision within 10 business days in year 1); they are
 * data here so operations can retune them without a deploy.
 */

import { hasPermission, IllegalTransitionError } from '../policy/policy-state-machine';

export type ClaimStatus =
  | 'submitted'
  | 'investigation'
  | 'assessment'
  | 'approved'
  | 'rejected'
  | 'payment'
  | 'closed';

export type ClaimTransition =
  | 'start_investigation'
  | 'start_assessment'
  | 'approve'
  | 'reject'
  | 'pay'
  | 'close'
  | 'reopen';

export interface ClaimTransitionRule {
  from: ClaimStatus[];
  to: ClaimStatus;
  permission: string;
  /** Hours allowed in the resulting state before the queue flags it. */
  slaHours: number | null;
  description: string;
  /** Whether an approved amount must be present to make this move. */
  requiresApprovedAmount?: boolean;
}

export const CLAIM_TRANSITIONS: Record<ClaimTransition, ClaimTransitionRule> = {
  start_investigation: {
    from: ['submitted'],
    to: 'investigation',
    permission: 'claims:investigate:all',
    slaHours: 72,
    description: 'Officer picks up the claim and begins fact-finding',
  },
  start_assessment: {
    from: ['investigation'],
    to: 'assessment',
    permission: 'claims:assess:all',
    slaHours: 96,
    description: 'Facts established; quantum being assessed',
  },
  approve: {
    from: ['assessment'],
    to: 'approved',
    permission: 'claims:approve:all',
    slaHours: 48,
    requiresApprovedAmount: true,
    description: 'Manager approves an indemnity amount',
  },
  reject: {
    from: ['investigation', 'assessment'],
    to: 'rejected',
    permission: 'claims:approve:all',
    slaHours: null,
    description: 'Claim declined with a stated reason',
  },
  pay: {
    from: ['approved'],
    to: 'payment',
    permission: 'claims:pay:all',
    slaHours: 24,
    description: 'Finance releases the payout',
  },
  close: {
    from: ['payment', 'rejected'],
    to: 'closed',
    permission: 'claims:close:all',
    slaHours: null,
    description: 'File closed',
  },
  reopen: {
    from: ['closed', 'rejected'],
    to: 'investigation',
    permission: 'claims:reopen:all',
    slaHours: 72,
    description: 'New evidence reopens the file',
  },
};

export function canTransitionClaim(from: ClaimStatus, transition: ClaimTransition): boolean {
  return CLAIM_TRANSITIONS[transition].from.includes(from);
}

export interface ClaimTransitionResult {
  status: ClaimStatus;
  /** Absolute deadline for the new state, or null if the state has no clock. */
  slaDueAt: Date | null;
}

export function applyClaimTransition(
  from: ClaimStatus,
  transition: ClaimTransition,
  actorPermissions: readonly string[],
  opts: { now?: Date; approvedXaf?: bigint | null } = {},
): ClaimTransitionResult {
  const rule = CLAIM_TRANSITIONS[transition];
  if (!rule.from.includes(from)) {
    throw new IllegalTransitionError('claim', from, transition);
  }
  if (!hasPermission(actorPermissions, rule.permission)) {
    throw new Error(`Missing permission "${rule.permission}" for claim.${transition}`);
  }
  if (rule.requiresApprovedAmount && (opts.approvedXaf == null || opts.approvedXaf <= 0n)) {
    throw new Error('An approved indemnity amount is required to approve a claim');
  }

  const now = opts.now ?? new Date();
  const slaDueAt =
    rule.slaHours === null ? null : new Date(now.getTime() + rule.slaHours * 3_600_000);

  return { status: rule.to, slaDueAt };
}

export function availableClaimTransitions(
  from: ClaimStatus,
  actorPermissions: readonly string[],
): ClaimTransition[] {
  return (Object.keys(CLAIM_TRANSITIONS) as ClaimTransition[]).filter(
    (t) =>
      CLAIM_TRANSITIONS[t].from.includes(from) &&
      hasPermission(actorPermissions, CLAIM_TRANSITIONS[t].permission),
  );
}

/** Queue urgency, used to sort the officer workbench. */
export type SlaState = 'none' | 'on_track' | 'due_soon' | 'breached';

export function slaState(slaDueAt: Date | null, now: Date = new Date()): SlaState {
  if (!slaDueAt) return 'none';
  const msLeft = slaDueAt.getTime() - now.getTime();
  if (msLeft < 0) return 'breached';
  if (msLeft < 24 * 3_600_000) return 'due_soon';
  return 'on_track';
}
