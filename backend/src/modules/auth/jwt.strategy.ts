import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import type { AuthenticatedUser } from '../../common/auth/current-user';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TokenService } from './token.service';
import type { AccessTokenClaims } from './token.service';

/**
 * Validates the bearer token and builds the request principal.
 *
 * The signature check alone is not enough. A token stays cryptographically
 * valid for its full fifteen minutes, so we also confirm the session behind
 * it has not been revoked — otherwise "sign out everywhere" and the
 * reuse-detection revocation would both be advisory for a quarter of an hour,
 * which is precisely the window an attacker with a stolen token wants.
 *
 * That costs one indexed lookup per request; correctness of revocation is
 * worth it. The row is small and hot, and it is the natural point to cache in
 * Redis if the read ever shows up in a profile.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      issuer: 'lih-api',
      audience: 'lih-clients',
    });
  }

  async validate(claims: AccessTokenClaims): Promise<AuthenticatedUser> {
    const session = await this.prisma.session.findUnique({
      where: { id: claims.sid },
      select: { revokedAt: true, expiresAt: true, user: { select: { status: true } } },
    });

    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw new UnauthorizedException('auth.refresh_token_invalid');
    }
    if (session.user.status !== 'active') {
      throw new UnauthorizedException('auth.account_suspended');
    }

    return {
      userId: claims.sub,
      tenantId: claims.tid,
      email: claims.email,
      roles: claims.roles,
      permissions: this.tokens.resolvePermissions(claims.roles),
      locale: claims.locale,
      sessionId: claims.sid,
      mfaVerified: claims.mfa,
      ...(claims.lawyerId ? { lawyerId: claims.lawyerId } : {}),
    };
  }
}
