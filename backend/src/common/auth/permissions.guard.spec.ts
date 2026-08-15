import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PermissionsGuard, PERMISSIONS_KEY, PUBLIC_KEY, MFA_REQUIRED_KEY } from './permissions.guard';
import type { AuthenticatedUser } from './current-user';

/**
 * The guard is the single point where authorisation is decided for every
 * route in the application. Its failure modes are the ones that matter most:
 * failing open, or letting a scope be widened by accident.
 */
describe('PermissionsGuard', () => {
  let reflector: Reflector;
  let guard: PermissionsGuard;

  const user: AuthenticatedUser = {
    userId: 'u1',
    tenantId: 't1',
    email: 'me.ango@cabinet-ango.cm',
    roles: ['lawyer'],
    permissions: ['policies:read:own', 'claims:create:own'],
    locale: 'fr',
    sessionId: 's1',
    mfaVerified: false,
  };

  function contextFor(principal?: AuthenticatedUser): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ user: principal }) }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext;
  }

  function metadata(values: Record<string, unknown>): void {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockImplementation((key: unknown) => values[key as string] as never);
  }

  beforeEach(() => {
    reflector = new Reflector();
    guard = new PermissionsGuard(reflector);
  });

  it('allows a route explicitly marked public', () => {
    metadata({ [PUBLIC_KEY]: true });
    expect(guard.canActivate(contextFor(undefined))).toBe(true);
  });

  it('denies an unauthenticated caller on a non-public route', () => {
    metadata({});
    expect(() => guard.canActivate(contextFor(undefined))).toThrow(ForbiddenException);
  });

  it('requires a session even when no permission is declared', () => {
    // The default must be "authenticated". A route whose author forgot to add
    // @RequirePermissions should still not be open to the world.
    metadata({ [PERMISSIONS_KEY]: [] });
    expect(() => guard.canActivate(contextFor(undefined))).toThrow(ForbiddenException);
    expect(guard.canActivate(contextFor(user))).toBe(true);
  });

  it('allows a caller holding the required permission', () => {
    metadata({ [PERMISSIONS_KEY]: ['policies:read:own'] });
    expect(guard.canActivate(contextFor(user))).toBe(true);
  });

  it('denies a caller missing the required permission', () => {
    metadata({ [PERMISSIONS_KEY]: ['claims:approve:all'] });
    expect(() => guard.canActivate(contextFor(user))).toThrow(/claims:approve:all/);
  });

  it('does not let an own-scoped permission satisfy an all-scoped route', () => {
    // The direction of scope widening is the whole point: :all implies :own,
    // never the reverse. Getting this backwards would let any lawyer read
    // every other member's policies.
    metadata({ [PERMISSIONS_KEY]: ['policies:read:all'] });
    expect(() => guard.canActivate(contextFor(user))).toThrow(ForbiddenException);
  });

  it('lets an all-scoped holder through an own-scoped route', () => {
    metadata({ [PERMISSIONS_KEY]: ['policies:read:own'] });
    const officer = { ...user, permissions: ['policies:read:all'] };
    expect(guard.canActivate(contextFor(officer))).toBe(true);
  });

  it('requires every declared permission, not just one', () => {
    metadata({ [PERMISSIONS_KEY]: ['policies:read:own', 'payments:refund:all'] });
    expect(() => guard.canActivate(contextFor(user))).toThrow(/payments:refund:all/);
  });

  it('blocks a step-up route until MFA has been satisfied', () => {
    metadata({ [PERMISSIONS_KEY]: ['policies:read:own'], [MFA_REQUIRED_KEY]: true });
    expect(() => guard.canActivate(contextFor(user))).toThrow(/Step-up authentication/);
    expect(guard.canActivate(contextFor({ ...user, mfaVerified: true }))).toBe(true);
  });

  it('honours a wildcard super-admin grant', () => {
    metadata({ [PERMISSIONS_KEY]: ['admin:roles:manage'] });
    expect(guard.canActivate(contextFor({ ...user, permissions: ['*'] }))).toBe(true);
  });
});
