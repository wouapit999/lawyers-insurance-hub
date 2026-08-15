import { Global, Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AzureBlobStorage } from './drivers/azure-blob.storage';
import { LocalDiskStorage } from './drivers/local-disk.storage';
import { StorageProvider, type StorageDriver } from './storage.interface';
import { SupabaseStorage } from './drivers/supabase.storage';

/**
 * Selects the storage driver from configuration.
 *
 * This is the single place the deployment target leaks into the application.
 * Everything above it injects StorageProvider and neither knows nor cares
 * whether the bytes are on a local disk, in Supabase, or in Azure Blob.
 *
 * Migrating to Azure is: install the SDK, set STORAGE_DRIVER=azure_blob,
 * copy the objects across. No calling code changes.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: StorageProvider,
      inject: [ConfigService],
      useFactory: (config: ConfigService): StorageProvider => {
        const logger = new Logger('StorageModule');
        const driver = config.get<StorageDriver>('STORAGE_DRIVER', 'local');
        const isProduction = config.get<string>('NODE_ENV') === 'production';

        switch (driver) {
          case 'supabase':
            logger.log('Storage driver: Supabase Storage');
            return new SupabaseStorage(config);

          case 'azure_blob':
            logger.log('Storage driver: Azure Blob Storage');
            return new AzureBlobStorage(config);

          case 'local':
          default:
            if (isProduction) {
              // Render, Railway, Fly and every other container platform give
              // you an ephemeral filesystem. Uploaded claim evidence would
              // survive until the next deploy and then vanish — silently,
              // and only noticed when a member's claim cannot be evidenced.
              logger.error(
                'STORAGE_DRIVER=local in production. Container filesystems are ' +
                  'EPHEMERAL — uploaded documents will be lost on every deploy. ' +
                  'Set STORAGE_DRIVER=supabase (free) or azure_blob.',
              );
            }
            logger.log('Storage driver: local disk');
            return new LocalDiskStorage(config);
        }
      },
    },
  ],
  exports: [StorageProvider],
})
export class StorageModule {}
