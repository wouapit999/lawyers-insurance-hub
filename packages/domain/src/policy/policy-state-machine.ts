/**
 * Policy lifecycle state machine.
 *
 * The approved lifecycle is:
 *   draft -> submitted -> under_review -> approved -> active
 *         -> suspended -> expired -> renewed
 *
 * Transitions are declared here, in one table, rather than scattered across
 * service methods as `if (policy.status === ...)` checks. Two reasons:
 *
 *   1. An insurance policy's status determines whether a claim can be filed
 *      against it and whether money may be collected. An illegal transition
 *      is a financial and legal problem, so it must be impossible to express,
 *      not merely discouraged.
 *   2. The permission required for each transition lives beside it, so
 *      "who may cancel a policy" is answerable by reading one file.
 */

export type PolicyStatus =
  | 'draft'
  | 'submitted'
  | 'under_review'
  | 'approved'
  | 'active'
  | 'suspended'
  | 'expired'
  | 'cancelled'
  | 'renewed';

export type PolicyTransition =
  | 'submit'
  | 'start_review'
  | 'approve'
  | 'reject'
  | 'activate'
  | 'suspend'
  | 'reinstate'
  | 'expire'
  | 'cancel'
  | 'renew';

export interface TransitionRule {
  from: PolicyStatus[];
  to: PolicyStatus;
  /** Permission code the actor must hold. */
  permission: string;
  /** Human-readable reason, surfaced in the audit log. */
  description: string;
}

export const POLICY_TRANSITIONS: Record<PolicyTransition, TransitionRule> = {
  submit: {
    from: ['draft'],
    to: 'submitted',
    permission: 'policies:submit:own',
    description: 'Lawyer submits a drafted application',
  },
  start_review: {
    from: ['submitted'],
    to: 'under_review',
    permission: 'policies:review:all',
    description: 'Underwriter picks up the application',
  },
  approve: {
    from: ['under_review'],
    to: 'approved',
    permission: 'policies:approve:all',
    description: 'Underwriting accepts the risk',
  },
  reject: {
    from: ['submitted', 'under_review'],
    to: 'cancelled',
    permission: 'policies:approve:all',
    description: 'Underwriting declines the risk',
  },
  activate: {
    from: ['approved'],
    to: 'active',
    // Deliberately not a human permission: only the payment module may
    // activate, and only on a settled first installment.
    permission: 'policies:activate:system',
    description: 'First installment settled — cover begins',
  },
  suspend: {
    from: ['active'],
    to: 'suspended',
    permission: 'policies:suspend:all',
    description: 'Non-payment or underwriting hold',
  },
  reinstate: {
    from: ['suspended'],
    to: 'active',
    permission: 'policies:suspend:all',
    description: 'Arrears cleared — cover resumes',
  },
  expire: {
    from: ['active', 'suspended'],
    to: 'expired',
    permission: 'policies:expire:system',
    description: 'Term ended without renewal',
  },
  cancel: {
    from: ['draft', 'submitted', 'under_review', 'approved', 'active', 'suspended'],
    to: 'cancelled',
    permission: 'policies:cancel:own',
    description: 'Cancelled by the policyholder or the insurer',
  },
  renew: {
    from: ['active', 'expired'],
    to: 'renewed',
    permission: 'policies:renew:own',
    description: 'Superseded by a successor policy',
  },
};

/** Statuses from which no transition leads anywhere. */
export const TERMINAL_POLICY_STATUSES: readonly PolicyStatus[] = ['cancelled', 'renewed'];

export class IllegalTransitionError extends Error {
  constructor(
    readonly entity: string,
    readonly from: string,
    readonly transition: string,
  ) {
    super(`Cannot ${transition} a ${entity} in status "${from}"`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: PolicyStatus, transition: PolicyTransition): boolean {
  return POLICY_TRANSITIONS[transition].from.includes(from);
}

/**
 * Resolve the next status, or throw. Callers pass the actor's permissions so
 * that authorisation and legality are decided together — a caller cannot
 * accidentally check one and forget the other.
 */
export function applyTransition(
  from: PolicyStatus,
  transition: PolicyTransition,
  actorPermissions: readonly string[],
): PolicyStatus {
  const rule = POLICY_TRANSITIONS[transition];
  if (!rule.from.includes(from)) {
    throw new IllegalTransitionError('policy', from, transition);
  }
  if (!hasPermission(actorPermissions, rule.permission)) {
    throw new Error(`Missing permission "${rule.permission}" for policy.${transition}`);
  }
  return rule.to;
}

/**
 * Permission match with `own`/`all` scope widening: holding
 * `policies:cancel:all` satisfies a requirement for `policies:cancel:own`,
 * and a wildcard `policies:*` or `*` satisfies anything in its resource.
 */
export function hasPermission(held: readonly string[], required: string): boolean {
  if (held.includes('*')) return true;
  if (held.includes(required)) return true;

  const [resource, action, scope] = required.split(':');
  if (held.includes(`${resource}:*`)) return true;
  if (scope === 'own' && held.includes(`${resource}:${action}:all`)) return true;
  return false;
}

/** Transitions available to this actor right now — drives UI button state. */
export function availableTransitions(
  from: PolicyStatus,
  actorPermissions: readonly string[],
): PolicyTransition[] {
  return (Object.keys(POLICY_TRANSITIONS) as PolicyTransition[]).filter(
    (t) =>
      POLICY_TRANSITIONS[t].from.includes(from) &&
      hasPermission(actorPermissions, POLICY_TRANSITIONS[t].permission),
  );
}
