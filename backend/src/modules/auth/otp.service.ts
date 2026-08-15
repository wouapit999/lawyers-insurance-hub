import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { OtpPurpose } from '@prisma/client';
import { randomInt } from 'node:crypto';

import { CryptoService } from '../../common/security/crypto.service';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * One-time codes for phone/email verification, password reset and MFA
 * fallback.
 *
 * Design decisions worth stating:
 *
 *  * Codes are **hashed** in the database. A support engineer reading the
 *    table must not be able to complete someone's password reset.
 *  * Six digits with a ten-minute life and a five-attempt cap. Six digits is
 *    a million combinations; the attempt cap, not the length, is what makes
 *    guessing hopeless, so the cap is enforced on the row rather than only by
 *    rate limiting the endpoint.
 *  * Requesting a new code invalidates the previous one, so a user who taps
 *    "resend" twice cannot be confused by two live codes.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  private static readonly TTL_MS = 10 * 60 * 1000;
  private static readonly MAX_ATTEMPTS = 5;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * Generate, persist and dispatch a code.
   *
   * @returns the code in non-production environments only, so a developer or
   *          an automated test can complete the flow without an SMS gateway.
   *          In production this is always null and the code exists only in
   *          the message that was sent.
   */
  async issue(
    userId: string,
    purpose: OtpPurpose,
    deliver: (code: string) => Promise<void>,
  ): Promise<{ devCode: string | null; expiresAt: Date }> {
    // randomInt is CSPRNG-backed; Math.random would be predictable enough to
    // matter for a password-reset code.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(Date.now() + OtpService.TTL_MS);

    await this.prisma.$transaction(async (tx) => {
      // Supersede any live code for this purpose.
      await tx.otpCode.updateMany({
        where: { userId, purpose, consumedAt: null },
        data: { consumedAt: new Date() },
      });

      await tx.otpCode.create({
        data: { userId, purpose, codeHash: this.crypto.sha256(code), expiresAt },
      });
    });

    await deliver(code);

    const isProd = process.env.NODE_ENV === 'production';
    if (!isProd) {
      this.logger.debug(`OTP for ${userId} (${purpose}): ${code}`);
    }
    return { devCode: isProd ? null : code, expiresAt };
  }

  /**
   * Check and consume a code.
   *
   * @throws BadRequestException with a translation key. The key distinguishes
   *         expired from wrong, because that difference is genuinely useful
   *         to a legitimate user and useless to an attacker who cannot get
   *         past the attempt cap either way.
   */
  async verify(userId: string, purpose: OtpPurpose, code: string): Promise<void> {
    const record = await this.prisma.otpCode.findFirst({
      where: { userId, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) {
      throw new BadRequestException('auth.otp_invalid');
    }
    if (record.expiresAt < new Date()) {
      throw new BadRequestException('auth.otp_expired');
    }
    if (record.attempts >= OtpService.MAX_ATTEMPTS) {
      await this.prisma.otpCode.update({
        where: { id: record.id },
        data: { consumedAt: new Date() },
      });
      throw new BadRequestException('auth.otp_too_many_attempts');
    }

    if (!this.crypto.safeEqual(record.codeHash, this.crypto.sha256(code))) {
      await this.prisma.otpCode.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException('auth.otp_invalid');
    }

    await this.prisma.otpCode.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });
  }
}
