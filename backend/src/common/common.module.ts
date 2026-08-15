import { Global, Module } from '@nestjs/common';

import { AuditService } from './audit/audit.service';
import { CryptoService } from './security/crypto.service';
import { PrismaService } from './prisma/prisma.service';

/**
 * Cross-cutting infrastructure every feature module depends on.
 *
 * Global because the alternative — importing CommonModule into all twelve
 * feature modules — is noise that hides the imports that carry real meaning.
 */
@Global()
@Module({
  providers: [PrismaService, CryptoService, AuditService],
  exports: [PrismaService, CryptoService, AuditService],
})
export class CommonModule {}
