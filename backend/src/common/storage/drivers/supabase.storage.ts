import {
  Injectable, InternalServerErrorException, Logger, NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

import {
  StorageProvider, type PutOptions, type SignedUrlOptions, type StoredObject,
} from '../storage.interface';

/**
 * Supabase Storage — the free-tier stand-in for Azure Blob.
 *
 * Chosen because the free plan needs no credit card, gives 1 GB, and speaks a
 * plain REST API, so this driver needs no SDK dependency at all — just fetch.
 * That keeps the container small and means one less package to audit.
 *
 * Uses the **service role key**, which bypasses Supabase's row-level
 * security. That is correct here: authorisation is already decided by this
 * application's own permission model before any call reaches storage, and the
 * bucket must never be readable by an anonymous client. It also means this
 * key is as sensitive as the database password — it belongs in the host's
 * secret store, never in the repository or a client bundle.
 */
@Injectable()
export class SupabaseStorage extends StorageProvider {
  readonly driver = 'supabase' as const;
  private readonly logger = new Logger(SupabaseStorage.name);

  private readonly url: string;
  private readonly serviceKey: string;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    super();
    this.url = (this.config.get<string>('SUPABASE_URL') ?? '').replace(/\/+$/, '');
    this.serviceKey = this.config.get<string>('SUPABASE_SERVICE_KEY') ?? '';
    this.bucket = this.config.get<string>('SUPABASE_STORAGE_BUCKET', 'lih-documents');

    if (!this.url || !this.serviceKey) {
      throw new Error(
        'STORAGE_DRIVER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_KEY',
      );
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.serviceKey}`,
      apikey: this.serviceKey,
      ...extra,
    };
  }

  private endpoint(path: string): string {
    return `${this.url}/storage/v1/${path}`;
  }

  async put(key: string, body: Buffer, options?: PutOptions): Promise<StoredObject> {
    const contentType = options?.contentType ?? 'application/octet-stream';

    const response = await fetch(
      this.endpoint(`object/${this.bucket}/${encodeURI(key)}`),
      {
        method: 'POST',
        headers: this.headers({
          'Content-Type': contentType,
          // Re-uploading the same key replaces it. Document versioning is
          // handled by our own `documents.version` column and a distinct key,
          // so an overwrite here is a genuine correction, not a lost version.
          'x-upsert': 'true',
          ...(options?.metadata
            ? { 'x-metadata': JSON.stringify(options.metadata) }
            : {}),
        }),
        body: new Uint8Array(body),
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.logger.error(`Supabase upload failed (${response.status}): ${detail}`);
      throw new InternalServerErrorException('Document upload failed');
    }

    return {
      key,
      sizeBytes: body.byteLength,
      contentType,
      sha256: createHash('sha256').update(body).digest('hex'),
    };
  }

  async get(key: string): Promise<Buffer> {
    const response = await fetch(
      this.endpoint(`object/${this.bucket}/${encodeURI(key)}`),
      { headers: this.headers() },
    );

    if (response.status === 404) throw new NotFoundException(`Object not found: ${key}`);
    if (!response.ok) throw new InternalServerErrorException('Document download failed');

    return Buffer.from(await response.arrayBuffer());
  }

  async exists(key: string): Promise<boolean> {
    const response = await fetch(
      this.endpoint(`object/info/${this.bucket}/${encodeURI(key)}`),
      { headers: this.headers() },
    );
    return response.ok;
  }

  async delete(key: string): Promise<void> {
    const response = await fetch(
      this.endpoint(`object/${this.bucket}/${encodeURI(key)}`),
      { method: 'DELETE', headers: this.headers() },
    );
    if (!response.ok && response.status !== 404) {
      throw new InternalServerErrorException('Document deletion failed');
    }
  }

  async getSignedUrl(key: string, options?: SignedUrlOptions): Promise<string> {
    const response = await fetch(
      this.endpoint(`object/sign/${this.bucket}/${encodeURI(key)}`),
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ expiresIn: options?.expiresIn ?? 300 }),
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.logger.error(`Supabase signed URL failed (${response.status}): ${detail}`);
      throw new InternalServerErrorException('Could not generate a download link');
    }

    const body = (await response.json()) as { signedURL: string };
    const url = `${this.url}/storage/v1${body.signedURL}`;
    return options?.downloadAs
      ? `${url}&download=${encodeURIComponent(options.downloadAs)}`
      : url;
  }
}
