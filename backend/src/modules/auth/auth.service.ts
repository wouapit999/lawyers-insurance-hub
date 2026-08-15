import {
  BadRequestException, ConflictException, Injectable, Logger, UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { authenticator } from 'otplib';

import { DEFAULT_TENANT_ID } from '../../config/configuration';
import { AuditService } from '../../common/audit/audit.service';
import { CryptoService } from '../../common/security/crypto.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OtpService } from './otp.service';
import { TokenService, type TokenPair } from './token.service';
import type {
  EnableMfaDto, LoginDto, ProfileSummaryDto, RegisterDto, ResetPasswordDto,
} from './dto/auth.dto';

interface RequestContext {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Authentication.
 *
 * Password hashing is Argon2id at the parameters below — memory-hard, so a
 * leaked hash costs an attacker RAM per guess rather than cheap GPU cycles.
 * These settings target roughly 100 ms per hash on the AKS node size we run,
 * which is imperceptible on login and ruinous at scale for cracking.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  private static readonly ARGON2_OPTIONS: argon2.Options = {
    type: argon2.argon2id,
    memoryCost: 19_456, // 19 MiB — OWASP minimum for argon2id
    timeCost: 2,
    parallelism: 1,
  };

  private static readonly MAX_FAILED_LOGINS = 5;
  private static readonly LOCKOUT_MINUTES = 15;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly otp: OtpService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  // =========================================================================
  // Registration
  // =========================================================================

  /**
   * Create a lawyer account and open a Bar verification.
   *
   * The account is usable immediately for browsing and quoting; only
   * subscribing is gated on verification. That is a deliberate product
   * decision from the blueprint — the verification wait was the worst point
   * in the journey, and blocking everything behind it loses applicants.
   */
  async register(dto: RegisterDto, ctx: RequestContext): Promise<{
    userId: string;
    lawyerId: string;
    verificationStatus: string;
  }> {
    const email = dto.email.toLowerCase().trim();

    const [existingUser, existingBar] = await Promise.all([
      this.prisma.user.findFirst({
        where: { OR: [{ email }, { phoneE164: dto.phone }] },
        select: { id: true },
      }),
      this.prisma.lawyerProfile.findUnique({
        where: { barNumber: dto.barNumber },
        select: { id: true },
      }),
    ]);

    if (existingUser) throw new ConflictException('errors.conflict.duplicate');
    if (existingBar) throw new ConflictException('onboarding.bar_number_taken');

    const passwordHash = await argon2.hash(dto.password, AuthService.ARGON2_OPTIONS);

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          tenantId: DEFAULT_TENANT_ID,
          email,
          phoneE164: dto.phone,
          passwordHash,
          preferredLang: dto.preferredLang ?? 'fr',
          status: 'active',
        },
      });

      const lawyerRole = await tx.role.findUnique({ where: { code: 'lawyer' } });
      if (lawyerRole) {
        await tx.userRole.create({ data: { userId: user.id, roleId: lawyerRole.id } });
      }

      const profile = await tx.lawyerProfile.create({
        data: {
          tenantId: DEFAULT_TENANT_ID,
          userId: user.id,
          barNumber: dto.barNumber.trim(),
          fullName: dto.fullName.trim(),
          admittedOn: new Date(dto.admittedOn),
          verificationStatus: 'pending',
        },
      });

      // The Bar has 24 hours before the queue escalates — one of the three
      // mitigations for the verification wait.
      await tx.barVerification.create({
        data: {
          tenantId: DEFAULT_TENANT_ID,
          lawyerId: profile.id,
          status: 'pending',
          slaDueAt: new Date(Date.now() + 24 * 3_600_000),
        },
      });

      await this.audit.record(
        {
          tenantId: DEFAULT_TENANT_ID,
          actorId: user.id,
          action: 'auth.register',
          entityType: 'User',
          entityId: user.id,
          after: { email, barNumber: dto.barNumber },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
        tx,
      );

      return { userId: user.id, lawyerId: profile.id };
    });

    // Verification codes are sent outside the transaction: a slow SMS gateway
    // must not hold a database transaction open.
    await this.otp.issue(result.userId, 'email_verification', async (code) => {
      this.logger.log(`[stub] email verification code for ${email}: ${code}`);
    });
    await this.otp.issue(result.userId, 'phone_verification', async (code) => {
      this.logger.log(`[stub] SMS verification code for ${dto.phone}: ${code}`);
    });

    return { ...result, verificationStatus: 'pending' };
  }

  // =========================================================================
  // Login
  // =========================================================================

  async login(
    dto: LoginDto,
    ctx: RequestContext,
  ): Promise<TokenPair | { mfaRequired: true; mfaToken: string }> {
    const email = dto.email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({
      where: { email },
      include: {
        roles: { include: { role: true } },
        lawyerProfile: { select: { id: true } },
      },
    });

    // Uniform failure for "no such user" and "wrong password". Argon2 is run
    // against a dummy hash when the user is absent so the response time does
    // not reveal which case it was.
    if (!user?.passwordHash) {
      await argon2.hash('timing-equalisation', AuthService.ARGON2_OPTIONS).catch(() => undefined);
      throw new UnauthorizedException('auth.invalid_credentials');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      throw new UnauthorizedException(`auth.account_locked|${minutes}`);
    }
    if (user.status === 'suspended' || user.status === 'closed') {
      throw new UnauthorizedException('auth.account_suspended');
    }

    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) {
      await this.registerFailedLogin(user.id, user.failedLogins, ctx);
      throw new UnauthorizedException('auth.invalid_credentials');
    }

    if (user.failedLogins > 0) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLogins: 0, lockedUntil: null },
      });
    }

    const device = dto.deviceFingerprint
      ? await this.upsertDevice(user.id, dto)
      : null;

    // --- MFA gate ---------------------------------------------------------
    if (user.mfaEnabled) {
      const mfaToken = await this.jwt.signAsync(
        { sub: user.id, purpose: 'mfa', did: device?.id ?? null },
        {
          secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
          expiresIn: '5m',
          issuer: 'lih-api',
          audience: 'lih-mfa',
        },
      );
      return { mfaRequired: true, mfaToken };
    }

    await this.audit.record({
      tenantId: user.tenantId,
      actorId: user.id,
      action: 'auth.login',
      entityType: 'User',
      entityId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return this.tokens.issue({
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      roles: user.roles.map((r) => r.role.code),
      lawyerId: user.lawyerProfile?.id ?? null,
      locale: user.preferredLang,
      mfaVerified: true, // no second factor configured, so nothing is pending
      deviceId: device?.id ?? null,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  /**
   * Progressive lockout after repeated failures.
   *
   * Locking the account rather than the IP is the right trade here: the
   * attacker controls their IP, and the Cameroonian mobile networks put many
   * legitimate users behind the same one.
   */
  private async registerFailedLogin(
    userId: string,
    current: number,
    ctx: RequestContext,
  ): Promise<void> {
    const failed = current + 1;
    const locked = failed >= AuthService.MAX_FAILED_LOGINS;

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLogins: failed,
        lockedUntil: locked
          ? new Date(Date.now() + AuthService.LOCKOUT_MINUTES * 60_000)
          : null,
      },
    });

    if (locked) {
      await this.audit.record({
        tenantId: DEFAULT_TENANT_ID,
        actorId: userId,
        action: 'auth.account_locked',
        entityType: 'User',
        entityId: userId,
        after: { failedLogins: failed },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    }
  }

  private async upsertDevice(userId: string, dto: LoginDto) {
    return this.prisma.device.upsert({
      where: { userId_fingerprint: { userId, fingerprint: dto.deviceFingerprint! } },
      create: {
        userId,
        fingerprint: dto.deviceFingerprint!,
        label: dto.deviceLabel ?? null,
        platform: dto.platform ?? null,
        lastSeenAt: new Date(),
      },
      update: { lastSeenAt: new Date(), label: dto.deviceLabel ?? undefined },
    });
  }

  // =========================================================================
  // MFA
  // =========================================================================

  async beginMfaEnrolment(userId: string, email: string): Promise<{ secret: string; otpauthUrl: string }> {
    const secret = authenticator.generateSecret();

    // Stored encrypted and not yet enabled: enrolment only completes once the
    // user proves the authenticator app has the secret, so a failed setup
    // cannot lock them out of their own account.
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaSecret: this.crypto.encrypt(secret) },
    });

    return {
      secret,
      otpauthUrl: authenticator.keyuri(email, 'Lawyers Insurance Hub', secret),
    };
  }

  async confirmMfaEnrolment(userId: string, dto: EnableMfaDto): Promise<{ enabled: boolean }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { mfaSecret: true, tenantId: true },
    });

    const secret = this.crypto.decrypt(user.mfaSecret);
    if (!secret) throw new BadRequestException('auth.mfa_invalid');

    if (!authenticator.verify({ token: dto.code, secret })) {
      throw new BadRequestException('auth.mfa_invalid');
    }

    await this.prisma.user.update({ where: { id: userId }, data: { mfaEnabled: true } });
    await this.audit.record({
      tenantId: user.tenantId,
      actorId: userId,
      action: 'auth.mfa_enabled',
      entityType: 'User',
      entityId: userId,
    });

    return { enabled: true };
  }

  async completeMfaLogin(mfaToken: string, code: string, ctx: RequestContext): Promise<TokenPair> {
    let payload: { sub: string; did: string | null };
    try {
      payload = await this.jwt.verifyAsync(mfaToken, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        issuer: 'lih-api',
        audience: 'lih-mfa',
      });
    } catch {
      throw new UnauthorizedException('auth.refresh_token_invalid');
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: payload.sub },
      include: {
        roles: { include: { role: true } },
        lawyerProfile: { select: { id: true } },
      },
    });

    const secret = this.crypto.decrypt(user.mfaSecret);
    if (!secret || !authenticator.verify({ token: code, secret })) {
      throw new UnauthorizedException('auth.mfa_invalid');
    }

    return this.tokens.issue({
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      roles: user.roles.map((r) => r.role.code),
      lawyerId: user.lawyerProfile?.id ?? null,
      locale: user.preferredLang,
      mfaVerified: true,
      deviceId: payload.did,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  // =========================================================================
  // Verification and password reset
  // =========================================================================

  async verifyContact(
    userId: string,
    purpose: 'phone_verification' | 'email_verification',
    code: string,
  ): Promise<{ verified: true }> {
    await this.otp.verify(userId, purpose, code);
    await this.prisma.user.update({
      where: { id: userId },
      data:
        purpose === 'email_verification'
          ? { emailVerifiedAt: new Date() }
          : { phoneVerifiedAt: new Date() },
    });
    return { verified: true };
  }

  /**
   * Start a password reset.
   *
   * Always reports success, whether or not the address exists. Confirming
   * which addresses have accounts would let anyone enumerate the membership
   * of the Bar's insurance scheme.
   */
  async requestPasswordReset(email: string): Promise<{ sent: true }> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      select: { id: true },
    });

    if (user) {
      await this.otp.issue(user.id, 'password_reset', async (code) => {
        this.logger.log(`[stub] password reset code for ${email}: ${code}`);
      });
    }
    return { sent: true };
  }

  async resetPassword(dto: ResetPasswordDto, ctx: RequestContext): Promise<{ reset: true }> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase().trim() },
      select: { id: true, tenantId: true },
    });
    if (!user) throw new BadRequestException('auth.otp_invalid');

    await this.otp.verify(user.id, 'password_reset', dto.code);

    const passwordHash = await argon2.hash(dto.newPassword, AuthService.ARGON2_OPTIONS);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, failedLogins: 0, lockedUntil: null },
    });

    // Whoever changed the password keeps their next session; everyone else is
    // signed out. If the reset was the legitimate owner recovering a
    // compromised account, this is what evicts the attacker.
    const revoked = await this.tokens.revokeAllForUser(user.id);

    await this.audit.record({
      tenantId: user.tenantId,
      actorId: user.id,
      action: 'auth.password_reset',
      entityType: 'User',
      entityId: user.id,
      after: { sessionsRevoked: revoked },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return { reset: true };
  }

  // =========================================================================
  // Profile
  // =========================================================================

  async profile(userId: string): Promise<ProfileSummaryDto> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        roles: { include: { role: true } },
        lawyerProfile: { select: { id: true, verificationStatus: true } },
      },
    });

    const roles = user.roles.map((r) => r.role.code);
    return {
      userId: user.id,
      email: user.email,
      locale: user.preferredLang,
      roles,
      permissions: this.tokens.resolvePermissions(roles),
      lawyerId: user.lawyerProfile?.id,
      verificationStatus: user.lawyerProfile?.verificationStatus,
      mfaEnabled: user.mfaEnabled,
      emailVerified: user.emailVerifiedAt !== null,
      phoneVerified: user.phoneVerifiedAt !== null,
    };
  }
}
