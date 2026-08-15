import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * The authenticated principal, assembled by JwtStrategy and attached to the
 * request. Every guard, service and controller reads the caller from here —
 * there is no other source of identity in the application.
 */
export interface AuthenticatedUser {
  userId: string;
  tenantId: string;
  email: string;
  roles: string[];
  /** Flattened permission codes; see @lih/domain permissionsForRoles(). */
  permissions: string[];
  locale: 'en' | 'fr';
  /** Present when the caller is a lawyer — saves a lookup on every own-scoped query. */
  lawyerId?: string;
  sessionId: string;
  mfaVerified: boolean;
}

export interface RequestWithUser extends Request {
  user?: AuthenticatedUser;
}

export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;
    return data && user ? user[data] : user;
  },
);
