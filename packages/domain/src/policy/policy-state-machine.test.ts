import {
  applyTransition,
  availableTransitions,
  canTransition,
  hasPermission,
  IllegalTransitionError,
} from './policy-state-machine';
import {
  applyClaimTransition,
  availableClaimTransitions,
  slaState,
} from '../claims/claim-state-machine';

const MANAGER = [
  'policies:review:all', 'policies:approve:all', 'policies:suspend:all',
  'policies:cancel:all', 'claims:approve:all', 'claims:close:all',
];
const LAWYER = ['policies:submit:own', 'policies:cancel:own', 'policies:renew:own'];

describe('policy state machine', () => {
  it('walks the approved happy path', () => {
    let status = applyTransition('draft', 'submit', LAWYER);
    expectEqual(status, 'submitted');
    status = applyTransition(status, 'start_review', MANAGER);
    expectEqual(status, 'under_review');
    status = applyTransition(status, 'approve', MANAGER);
    expectEqual(status, 'approved');
    status = applyTransition(status, 'activate', ['policies:activate:system']);
    expectEqual(status, 'active');
  });

  it('refuses to activate a policy that was never approved', () => {
    expectThrows(
      () => applyTransition('draft', 'activate', ['*']),
      IllegalTransitionError,
    );
    expectEqual(canTransition('submitted', 'activate'), false);
  });

  it('refuses to reactivate an expired policy — renewal creates a new one', () => {
    expectThrows(() => applyTransition('expired', 'activate', ['*']), IllegalTransitionError);
    expectEqual(canTransition('expired', 'renew'), true);
  });

  it('keeps activation out of human hands', () => {
    // Even a manager cannot switch cover on without a settled payment: only
    // the payment module holds policies:activate:system.
    expectThrows(() => applyTransition('approved', 'activate', MANAGER), /Missing permission/);
  });

  it('lets a lawyer cancel their own policy but not review one', () => {
    expectEqual(applyTransition('active', 'cancel', LAWYER), 'cancelled');
    expectThrows(() => applyTransition('submitted', 'start_review', LAWYER), /Missing permission/);
  });

  it('offers only the transitions the actor can actually perform', () => {
    expectDeepEqual(availableTransitions('submitted', LAWYER), ['cancel']);
    expectDeepEqual(
      availableTransitions('submitted', MANAGER).sort(),
      ['cancel', 'reject', 'start_review'],
    );
  });
});

describe('permission scope widening', () => {
  it('lets an :all holder satisfy an :own requirement', () => {
    expectEqual(hasPermission(['policies:cancel:all'], 'policies:cancel:own'), true);
  });

  it('does not let an :own holder act on someone else', () => {
    expectEqual(hasPermission(['policies:cancel:own'], 'policies:cancel:all'), false);
  });

  it('honours wildcards', () => {
    expectEqual(hasPermission(['*'], 'anything:at:all'), true);
    expectEqual(hasPermission(['claims:*'], 'claims:approve:all'), true);
    expectEqual(hasPermission(['claims:*'], 'policies:approve:all'), false);
  });
});

describe('claim state machine', () => {
  const OFFICER = ['claims:investigate:all', 'claims:assess:all'];
  const now = new Date('2026-08-14T09:00:00Z');

  it('starts an SLA clock on entering a timed state', () => {
    const { status, slaDueAt } = applyClaimTransition('submitted', 'start_investigation', OFFICER, { now });
    expectEqual(status, 'investigation');
    expectEqual(slaDueAt?.toISOString(), '2026-08-17T09:00:00.000Z'); // +72h
  });

  it('will not approve a claim without an amount', () => {
    expectThrows(
      () => applyClaimTransition('assessment', 'approve', ['claims:approve:all'], { now }),
      /approved indemnity amount is required/,
    );
  });

  it('approves when an amount is present', () => {
    const { status } = applyClaimTransition('assessment', 'approve', ['claims:approve:all'], {
      now,
      approvedXaf: 450000n,
    });
    expectEqual(status, 'approved');
  });

  it('will not pay a claim that was never approved', () => {
    expectThrows(
      () => applyClaimTransition('assessment', 'pay', ['*'], { now }),
      /Cannot pay a claim in status "assessment"/,
    );
  });

  it('classifies SLA urgency for the officer queue', () => {
    expectEqual(slaState(null, now), 'none');
    expectEqual(slaState(new Date('2026-08-13T09:00:00Z'), now), 'breached');
    expectEqual(slaState(new Date('2026-08-14T20:00:00Z'), now), 'due_soon');
    expectEqual(slaState(new Date('2026-08-20T09:00:00Z'), now), 'on_track');
  });

  it('hides transitions an officer may not perform', () => {
    expectDeepEqual(availableClaimTransitions('assessment', OFFICER), []);
    expectDeepEqual(
      availableClaimTransitions('assessment', ['claims:approve:all']).sort(),
      ['approve', 'reject'],
    );
  });
});
