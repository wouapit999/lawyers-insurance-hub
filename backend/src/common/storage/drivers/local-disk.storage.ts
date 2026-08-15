import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';

import {
  StorageProvider, type PutOptions, type SignedUrlOptions, type StoredObject,
} from '../storage.interface';

/**
 * Local filesystem storage — development and self-hosting only.
 *
 * Explicitly NOT suitable for Render's free tier or any container platform:
 * the filesystem is ephemeral, so every deploy and every restart destroys
 * uploaded claim evidence. The bootstrap logs a warning if it sees this
 * driver selected outside development.
 */
@Injectable()
export class LocalDiskStorage extends StorageProvider {
  readonly driver = 'local' as const;
  private readonly logger = new Logger(LocalDiskStorage.name);
  private readonly root: string;
  private readonly signingKey: string;

  constructor(private readonly config: ConfigService) {
    super();
    this.root = resolve(this.config.get<string>('LOCAL_STORAGE_PATH', './storage'));
    // Signed URLs still need to be unforgeable locally, or the dev
    // environment teaches a habit that breaks in production.
    this.signingKey =
      this.config.get<string>('PII_ENCRYPTION_KEY') ?? 'dev-only-signing-key';
  }

  /**
   * Resolve a key to an absolute path, refusing anything that escapes the
   * root. A key reaching this method may have come from a filename a user
   * chose, and "../../.env" is the oldest trick there is.
   */
  private pathFor(key: string): string {
    const target = resolve(join(this.root, normalize(key)));
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error(`Refusing to access a path outside the storage root: ${key}`);
    }
    return target;
  }

  async put(key: string, body: Buffer, options?: PutOptions): Promise<StoredObject> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);

    return {
      key,
      sizeBytes: body.byteLength,
      contentType: options?.contentType ?? 'application/octet-stream',
      sha256: createHash('sha256').update(body).digest('hex'),
    };
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch {
      throw new NotFoundException(`Object not found: ${key}`);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async getSignedUrl(key: string, options?: SignedUrlOptions): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + (options?.expiresIn ?? 300);
    const signature = createHmac('sha256', this.signingKey)
      .update(`${key}:${expires}`)
      .digest('hex');

    const base = this.config.get<string>('PUBLIC_API_URL', 'http://localhost:3000');
    const params = new URLSearchParams({ expires: String(expires), signature });
    if (options?.downloadAs) params.set('filename', options.downloadAs);

    return `${base}/v1/documents/local/${encodeURIComponent(key)}?${params.toString()}`;
  }

  /** Used by the local download route to validate a signature. */
  verifySignature(key: string, expires: number, signature: string): boolean {
    if (expires < Math.floor(Date.now() / 1000)) return false;
    const expected = createHmac('sha256', this.signingKey)
      .update(`${key}:${expires}`)
      .digest('hex');
    return expected === signature;
  }
}
