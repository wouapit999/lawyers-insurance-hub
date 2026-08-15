/**
 * Object storage abstraction.
 *
 * The platform stores policy certificates, claim evidence, receipts and
 * identity documents. Where those bytes physically live is a deployment
 * decision, not an application one — so every module talks to this interface
 * and never to a vendor SDK.
 *
 * Today the free-tier deployment uses Supabase Storage; production on Azure
 * will use Blob Storage. Moving between them is a change to STORAGE_DRIVER
 * and a set of credentials, with no change to any calling code.
 *
 * The same pattern as PaymentProvider, for the same reason: the thing most
 * likely to change is the vendor, and the thing that must not change is the
 * business logic above it.
 */

export type StorageDriver = 'local' | 'supabase' | 'azure_blob';

export interface StoredObject {
  /** Provider-agnostic key, e.g. "claims/2026/CLM-2026-000042/photo-1.jpg". */
  key: string;
  sizeBytes: number;
  contentType: string;
  /** SHA-256 of the bytes, used for integrity and duplicate detection. */
  sha256: string;
}

export interface PutOptions {
  contentType?: string;
  /**
   * Retention class. Certificates and claim evidence are kept for the CIMA
   * ten-year window; a thumbnail is not. Drivers that support lifecycle
   * rules map this onto them.
   */
  retention?: 'standard' | 'long_term';
  /** Arbitrary metadata; ignored by drivers that cannot store it. */
  metadata?: Record<string, string>;
}

export interface SignedUrlOptions {
  /** Seconds. Kept deliberately short — see the note in getSignedUrl. */
  expiresIn?: number;
  /** Filename offered to the browser on download. */
  downloadAs?: string;
}

export abstract class StorageProvider {
  abstract readonly driver: StorageDriver;

  /** Store bytes and return the object's descriptor. */
  abstract put(key: string, body: Buffer, options?: PutOptions): Promise<StoredObject>;

  abstract get(key: string): Promise<Buffer>;

  abstract exists(key: string): Promise<boolean>;

  /**
   * Delete an object.
   *
   * Note that most objects here are legally retained: a claim document is
   * evidence for ten years after closure. Callers should be deleting drafts
   * and superseded versions, not records — the retention policy lives with
   * the caller, and the driver simply obeys.
   */
  abstract delete(key: string): Promise<void>;

  /**
   * A time-limited URL the client can fetch directly.
   *
   * Short expiry by default. These URLs carry no authentication of their own,
   * so anyone holding one holds the document — a certificate naming an
   * advocate, or photographs from a claim. Five minutes is enough for a
   * browser to start a download and short enough that a leaked URL from a
   * log or a chat message is already dead.
   */
  abstract getSignedUrl(key: string, options?: SignedUrlOptions): Promise<string>;

  /** Build a stable, collision-free key. */
  buildKey(parts: {
    kind: string;
    ownerRef: string;
    fileName: string;
    version?: number;
  }): string {
    const safeName = parts.fileName
      .normalize('NFKD')
      .replace(/[^\w.\-]/g, '_')
      .slice(-120);
    const version = parts.version && parts.version > 1 ? `.v${parts.version}` : '';
    const year = new Date().getUTCFullYear();
    return `${parts.kind}/${year}/${parts.ownerRef}/${safeName}${version}`;
  }
}
