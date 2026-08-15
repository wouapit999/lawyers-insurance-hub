import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual,
} from 'node:crypto';

/**
 * Column-level encryption for the PII the schema marks as encrypted:
 * national ID numbers, passport numbers, MFA secrets.
 *
 * AES-256-GCM with a random 12-byte IV per value and the auth tag stored
 * alongside. Format: `v1.<iv_b64>.<tag_b64>.<ciphertext_b64>`. The version
 * prefix is what makes key rotation possible later without guessing how an
 * old value was written.
 *
 * Why encrypt at column level when the disk is already encrypted: disk
 * encryption protects against someone walking off with the drive. It does
 * nothing about a leaked backup, an over-broad support query, or a log line
 * that captured a row. These are the realistic exposures for a national ID
 * number, and they are the ones this closes.
 *
 * In deployed environments the key comes from Azure Key Vault via the
 * container's environment; it is never in the repository or in CI variables.
 */
@Injectable()
export class CryptoService implements OnModuleInit {
  private readonly logger = new Logger(CryptoService.name);
  private key: Buffer | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const raw = this.config.get<string>('PII_ENCRYPTION_KEY');
    if (!raw) {
      // Validated as required in production by validateEnvironment(); in dev
      // and test we degrade to passthrough so a developer can run without a
      // key, and we say so loudly.
      this.logger.warn(
        'PII_ENCRYPTION_KEY is not set — PII will be stored UNENCRYPTED. ' +
          'This is permitted in development only.',
      );
      return;
    }
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error(
        `PII_ENCRYPTION_KEY must decode to exactly 32 bytes, got ${key.length}`,
      );
    }
    this.key = key;
  }

  encrypt(plaintext: string | null | undefined): string | null {
    if (plaintext == null || plaintext === '') return null;
    if (!this.key) return plaintext;

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
      'v1',
      iv.toString('base64'),
      tag.toString('base64'),
      ciphertext.toString('base64'),
    ].join('.');
  }

  decrypt(stored: string | null | undefined): string | null {
    if (stored == null || stored === '') return null;
    if (!this.key || !stored.startsWith('v1.')) return stored;

    const [, ivB64, tagB64, dataB64] = stored.split('.');
    if (!ivB64 || !tagB64 || !dataB64) return null;

    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(ivB64, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // A failed auth tag means the ciphertext was altered. Never return a
      // partial or guessed value.
      this.logger.error('PII decryption failed — ciphertext may have been tampered with');
      return null;
    }
  }

  /**
   * What the UI shows by default. A support agent verifying identity needs
   * the last four characters; nobody needs the whole number on screen.
   */
  mask(value: string | null | undefined, visible = 4): string | null {
    if (!value) return null;
    if (value.length <= visible) return '•'.repeat(value.length);
    return '•'.repeat(value.length - visible) + value.slice(-visible);
  }

  /** SHA-256 hex — for refresh-token lookup and document integrity. */
  sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  /** Constant-time comparison for anything secret. */
  safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
