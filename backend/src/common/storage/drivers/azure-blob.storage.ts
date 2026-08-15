import {
  Injectable, InternalServerErrorException, Logger, NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

import {
  StorageProvider, type PutOptions, type SignedUrlOptions, type StoredObject,
} from '../storage.interface';

/**
 * Azure Blob Storage — the production target, once an Azure subscription
 * exists.
 *
 * The SDK is loaded dynamically rather than imported at the top of the file.
 * That is deliberate: @azure/storage-blob is a large dependency, and the
 * free-tier deployment never uses this driver. A static import would pull it
 * into every container image and every CI install for nothing.
 *
 * To switch to Azure:
 *   npm install @azure/storage-blob --workspace @lih/api
 *   STORAGE_DRIVER=azure_blob
 *   AZURE_STORAGE_CONNECTION_STRING=...   (or use workload identity)
 *
 * Nothing else in the application changes.
 */
@Injectable()
export class AzureBlobStorage extends StorageProvider {
  readonly driver = 'azure_blob' as const;
  private readonly logger = new Logger(AzureBlobStorage.name);

  private containerClient: any;
  // Untyped on purpose: @azure/storage-blob is not a dependency of the
  // free-tier build, so its types are not present at compile time.
  private sdk: any = null;

  constructor(private readonly config: ConfigService) {
    super();
  }

  private async client(): Promise<any> {
    if (this.containerClient) return this.containerClient;

    try {
      // Computed specifier keeps TypeScript from resolving the module at
      // compile time, which would fail when the SDK is not installed.
      const specifier = '@azure/storage-blob';
      this.sdk = await import(/* webpackIgnore: true */ specifier);
    } catch {
      throw new Error(
        'STORAGE_DRIVER=azure_blob requires @azure/storage-blob. ' +
          'Install it with: npm install @azure/storage-blob --workspace @lih/api',
      );
    }

    const connectionString = this.config.get<string>('AZURE_STORAGE_CONNECTION_STRING');
    const accountName = this.config.get<string>('AZURE_STORAGE_ACCOUNT');
    const container = this.config.get<string>('AZURE_STORAGE_CONTAINER', 'lih-documents');

    let serviceClient: any;

    if (connectionString) {
      serviceClient = this.sdk.BlobServiceClient.fromConnectionString(connectionString);
    } else if (accountName) {
      // Workload identity — the preferred production path. No key is stored
      // anywhere; the pod authenticates as itself.
      const identitySpecifier = '@azure/identity';
      const identity: any = await import(identitySpecifier).catch(() => {
        throw new Error(
          'Workload identity requires @azure/identity. Install it, or set ' +
            'AZURE_STORAGE_CONNECTION_STRING instead.',
        );
      });
      const { DefaultAzureCredential } = identity;
      serviceClient = new this.sdk.BlobServiceClient(
        `https://${accountName}.blob.core.windows.net`,
        new DefaultAzureCredential(),
      );
    } else {
      throw new Error(
        'STORAGE_DRIVER=azure_blob requires AZURE_STORAGE_CONNECTION_STRING ' +
          'or AZURE_STORAGE_ACCOUNT',
      );
    }

    this.containerClient = serviceClient.getContainerClient(container);
    return this.containerClient;
  }

  async put(key: string, body: Buffer, options?: PutOptions): Promise<StoredObject> {
    const container = await this.client();
    const blob = container.getBlockBlobClient(key);
    const contentType = options?.contentType ?? 'application/octet-stream';

    await blob.upload(body, body.byteLength, {
      blobHTTPHeaders: { blobContentType: contentType },
      metadata: options?.metadata,
      // Long-term objects go straight to cool: a claim document is written
      // once and read rarely, but must survive ten years.
      tier: options?.retention === 'long_term' ? 'Cool' : undefined,
    });

    return {
      key,
      sizeBytes: body.byteLength,
      contentType,
      sha256: createHash('sha256').update(body).digest('hex'),
    };
  }

  async get(key: string): Promise<Buffer> {
    const container = await this.client();
    try {
      return await container.getBlockBlobClient(key).downloadToBuffer();
    } catch (error: any) {
      if (error?.statusCode === 404) throw new NotFoundException(`Object not found: ${key}`);
      this.logger.error(`Azure Blob download failed for ${key}`, error);
      throw new InternalServerErrorException('Document download failed');
    }
  }

  async exists(key: string): Promise<boolean> {
    const container = await this.client();
    return container.getBlockBlobClient(key).exists();
  }

  async delete(key: string): Promise<void> {
    const container = await this.client();
    await container.getBlockBlobClient(key).deleteIfExists();
  }

  async getSignedUrl(key: string, options?: SignedUrlOptions): Promise<string> {
    const container = await this.client();
    const blob = container.getBlockBlobClient(key);

    const expiresOn = new Date(Date.now() + (options?.expiresIn ?? 300) * 1000);

    return blob.generateSasUrl({
      permissions: this.sdk.BlobSASPermissions.parse('r'), // read only, never write
      expiresOn,
      ...(options?.downloadAs
        ? { contentDisposition: `attachment; filename="${options.downloadAs}"` }
        : {}),
    });
  }
}
