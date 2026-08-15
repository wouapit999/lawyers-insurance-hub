import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { hasPermission } from '@lih/domain';

import type { RequestWithUser } from './current-user';

export const PERMISSIONS_KEY = 'required_permissions';
export const PUBLIC_KEY = 'is_public';
export const MFA_REQUIRED_KEY = 'mfa_required';

/**
 * Declare the permission a route needs:
 *
 *   @RequirePermissions('claims:approve:all')
 *   @Post(':id/approve')
 *
 * Multiple codes mean ALL are required. For "any of", split the route.
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Opt a route out of authentication entirely (login, webhooks, health). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/**
 * Demand a fresh MFA challenge for this route regardless of the session's
 * age. Used on the genuinely dangerous operations — issuing a refund,
 * granting a role — where a borrowed unlocked laptop should not be enough.
 */
export const RequireMfa = () => SetMetadata(MFA_REQUIRED_KEY, true);

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    const mfaRequired = this.reflector.getAllAndOverride<boolean>(MFA_REQUIRED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (mfaRequired && !user.mfaVerified) {
      throw new ForbiddenException('Step-up authentication required for this action');
    }

    // A route with no declared permission still requires a valid session —
    // authentication is the default, and only @Public() removes it.
    if (!required || required.length === 0) return true;

    const missing = required.filter((p) => !hasPermission(user.permissions, p));
    if (missing.length > 0) {
      throw new ForbiddenException(
        `Missing permission${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
      );
    }

    return true;
  }
}
