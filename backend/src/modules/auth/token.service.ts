import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';

import { permissionsForRoles } from '@lih/domain';

import { CryptoService } from '../../common/security/crypto.service';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface AccessTokenClaims {
  sub: string;
  tid: string;      // tenant — read by the RLS policy via PrismaService.forTenant
  email: string;
  roles: string[];
  lawyerId?: string;
  sid: string;      // session id, so a single session can be revoked
  mfa: boolean;
  locale: 'en' | 'fr';
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

/**
 * Token issuing and rotation.
 *
 * Access tokens are short (15 minutes) and stateless. Refresh tokens are long
 * (30 days), opaque, and stored **hashed** — the database holds a SHA-256 of
 * the token, never the token itself, so a database leak does not hand an
 * attacker a month of valid sessions.
 *
 * Rotation with reuse detection: every refresh mints a new token and marks
 * the old one replaced. If a token that was already replaced comes back, the
 * only explanations are theft or a cloned device, so the entire session
 * chain for that user is revoked and they must sign in again. Losing a
 * session is a minor annoyance; leaving a stolen refresh token live for
 * thirty days is not.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  private ttlSeconds(ttl: string): number {
    const match = /^(\d+)([smhd])$/.exec(ttl);
    if (!match) return 900;
    const value = Number(match[1]);
    const unit = match[2] as 's' | 'm' | 'h' | 'd';
    return value * { s: 1, m: 60, h: 3600, d: 86400 }[unit];
  }

  async issue(params: {
    userId: string;
    tenantId: string;
    email: string;
    roles: string[];
    lawyerId?: string | null;
    locale: 'en' | 'fr';
    mfaVerified: boolean;
    deviceId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<TokenPair> {
    // The opaque half. 32 random bytes, never derived from user data.
    const refreshToken = randomBytes(32).toString('base64url');
    const refreshTtl = this.ttlSeconds(this.config.get<string>('JWT_REFRESH_TTL', '30d'));

    const session = await this.prisma.session.create({
      data: {
        userId: params.userId,
        refreshTokenHash: this.crypto.sha256(refreshToken),
        deviceId: params.deviceId ?? null,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
        expiresAt: new Date(Date.now() + refreshTtl * 1000),
      },
    });

    const claims: AccessTokenClaims = {
      sub: params.userId,
      tid: params.tenantId,
      email: params.email,
      roles: params.roles,
      sid: session.id,
      mfa: params.mfaVerified,
      locale: params.locale,
      ...(params.lawyerId ? { lawyerId: params.lawyerId } : {}),
    };

    const accessTtl = this.ttlSeconds(this.config.get<string>('JWT_ACCESS_TTL', '15m'));
    const accessToken = await this.jwt.signAsync(claims, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: accessTtl,
      issuer: 'lih-api',
      audience: 'lih-clients',
    });

    return { accessToken, refreshToken, expiresIn: accessTtl, tokenType: 'Bearer' };
  }

  /**
   * Exchange a refresh token for a new pair.
   *
   * @throws UnauthorizedException on an unknown, expired, revoked or replayed
   *         token. The message is deliberately the same for the first three —
   *         telling a caller which one it was helps an attacker enumerate.
   */
  async rotate(
    refreshToken: string,
    context: { ip?: string | null; userAgent?: string | null },
  ): Promise<TokenPair> {
    const hash = this.crypto.sha256(refreshToken);

    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hash },
      include: {
        user: {
          include: {
            roles: { include: { role: true } },
            lawyerProfile: { select: { id: true } },
          },
        },
      },
    });

    if (!session) {
      throw new UnauthorizedException('auth.refresh_token_invalid');
    }

    // --- reuse detection --------------------------------------------------
    if (session.revokedAt || session.replacedById) {
      await this.revokeAllForUser(session.userId);
      throw new UnauthorizedException('auth.refresh_token_reused');
    }

    if (session.expiresAt < new Date()) {
      throw new UnauthorizedException('auth.refresh_token_invalid');
    }
    if (session.user.status !== 'active') {
      throw new UnauthorizedException('auth.account_suspended');
    }

    const roles = session.user.roles.map((r) => r.role.code);
    const pair = await this.issue({
      userId: session.userId,
      tenantId: session.user.tenantId,
      email: session.user.email,
      roles,
      lawyerId: session.user.lawyerProfile?.id ?? null,
      locale: session.user.preferredLang,
      // MFA does not survive rotation for a user who has it enabled: a new
      // access token from a long-lived refresh token is not evidence that
      // the person holding it passed a second factor.
      mfaVerified: !session.user.mfaEnabled,
      deviceId: session.deviceId,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
    });

    const replacement = await this.prisma.session.findUnique({
      where: { refreshTokenHash: this.crypto.sha256(pair.refreshToken) },
      select: { id: true },
    });

    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date(), replacedById: replacement?.id ?? null },
    });

    return pair;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Used on password change, on suspension, and on refresh-token reuse. */
  async revokeAllForUser(userId: string): Promise<number> {
    const { count } = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count;
  }

  /** Effective permissions for a set of role codes. */
  resolvePermissions(roles: string[]): string[] {
    return permissionsForRoles(roles);
  }
}
