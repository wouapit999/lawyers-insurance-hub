import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { PUBLIC_KEY } from './permissions.guard';

/**
 * Global authentication guard.
 *
 * Registered application-wide so that authentication is the default and a
 * route opts out explicitly with @Public(). The inverse arrangement — guard
 * each controller by hand — fails open: the endpoint someone forgets to
 * decorate is unprotected, and nothing in the build will tell you.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}
