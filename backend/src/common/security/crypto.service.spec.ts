import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';

import { CryptoService } from './crypto.service';

/**
 * PII encryption is the control that stops a leaked backup from exposing
 * every member's national ID number, so these tests check the properties
 * that make it worth having — not just that it round-trips.
 */
describe('CryptoService', () => {
  const key = randomBytes(32).toString('base64');

  async function build(encryptionKey?: string): Promise<CryptoService> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        CryptoService,
        {
          provide: ConfigService,
          useValue: { get: () => encryptionKey },
        },
      ],
    }).compile();

    const service = moduleRef.get(CryptoService);
    service.onModuleInit();
    return service;
  }

  describe('with a key configured', () => {
    let crypto: CryptoService;
    beforeEach(async () => {
      crypto = await build(key);
    });

    it('round-trips a value', () => {
      const plaintext = '1234567890123';
      expect(crypto.decrypt(crypto.encrypt(plaintext))).toBe(plaintext);
    });

    it('never stores the plaintext in the ciphertext', () => {
      const encrypted = crypto.encrypt('CM1234567890')!;
      expect(encrypted).not.toContain('CM1234567890');
      expect(encrypted.startsWith('v1.')).toBe(true);
      expect(encrypted.split('.')).toHaveLength(4);
    });

    it('produces a different ciphertext each time for the same input', () => {
      // A deterministic ciphertext would let anyone with database access tell
      // which two members share an ID number, and confirm a guessed value.
      const a = crypto.encrypt('same-value');
      const b = crypto.encrypt('same-value');
      expect(a).not.toBe(b);
      expect(crypto.decrypt(a)).toBe(crypto.decrypt(b));
    });

    it('refuses to decrypt a tampered ciphertext', () => {
      const encrypted = crypto.encrypt('1234567890123')!;
      const [version, iv, tag, data] = encrypted.split('.');
      const flipped = Buffer.from(data!, 'base64');
      flipped[0] = flipped[0]! ^ 0xff;
      const tampered = [version, iv, tag, flipped.toString('base64')].join('.');

      // GCM's auth tag catches the modification. Returning null rather than
      // garbage is the point: a partially-decrypted ID number must never
      // reach a caller as if it were real.
      expect(crypto.decrypt(tampered)).toBeNull();
    });

    it('rejects a key of the wrong length at startup', async () => {
      await expect(build(Buffer.from('too-short').toString('base64')))
        .rejects.toThrow(/exactly 32 bytes/);
    });

    it('handles empty and null input without throwing', () => {
      expect(crypto.encrypt(null)).toBeNull();
      expect(crypto.encrypt('')).toBeNull();
      expect(crypto.decrypt(null)).toBeNull();
    });
  });

  describe('without a key (development only)', () => {
    it('passes values through instead of failing', async () => {
      const crypto = await build(undefined);
      expect(crypto.encrypt('plain')).toBe('plain');
      expect(crypto.decrypt('plain')).toBe('plain');
    });
  });

  describe('mask()', () => {
    let crypto: CryptoService;
    beforeEach(async () => {
      crypto = await build(key);
    });

    it('leaves only the last four characters readable', () => {
      expect(crypto.mask('1234567890123')).toBe('•••••••••0123');
    });

    it('hides a short value entirely rather than revealing most of it', () => {
      expect(crypto.mask('123')).toBe('•••');
    });

    it('returns null for absent values', () => {
      expect(crypto.mask(null)).toBeNull();
    });
  });

  describe('safeEqual()', () => {
    let crypto: CryptoService;
    beforeEach(async () => {
      crypto = await build(key);
    });

    it('matches identical values and rejects different ones', () => {
      expect(crypto.safeEqual('abc123', 'abc123')).toBe(true);
      expect(crypto.safeEqual('abc123', 'abc124')).toBe(false);
    });

    it('rejects values of differing length without throwing', () => {
      expect(crypto.safeEqual('short', 'much-longer-value')).toBe(false);
    });
  });
});
