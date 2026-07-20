// src/infrastructure/persistence/persistence.module.ts
import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { PrismaCustomerRepository } from './prisma-customer.repository';
import { PrismaVerificationRequestRepository } from './prisma-verification-request.repository';
import { PrismaDocumentRepository } from './prisma-document.repository';
import { PrismaAuditEventRepository } from '../audit/prisma-audit-event.repository';
import { EncryptionService } from '../encryption/encryption.service';
import { LocalFileKms } from '../encryption/local-file-kms';
import {
  KMS_PORT,
  CUSTOMER_REPOSITORY,
  VERIFICATION_REQUEST_REPOSITORY,
  DOCUMENT_REPOSITORY,
  AUDIT_TRAIL_PORT,
} from './tokens';

/**
 * @Global so PrismaService (a single connection pool) and the repository
 * ports are available everywhere without every feature module re-importing
 * this one explicitly. Uses string injection tokens (tokens.ts) rather than
 * class references, since NestJS DI needs a runtime token for interface
 * types — TypeScript interfaces (CustomerRepositoryPort etc.) don't exist
 * at runtime to inject against directly.
 */
@Global()
@Module({
  providers: [
    PrismaService,
    {
      provide: KMS_PORT,
      useFactory: (config: ConfigService) =>
        new LocalFileKms(config.get<string>('KMS_MASTER_KEY_PATH')!),
      inject: [ConfigService],
    },
    {
      provide: EncryptionService,
      useFactory: (kms: LocalFileKms) => new EncryptionService(kms),
      inject: [KMS_PORT],
    },
    {
      provide: CUSTOMER_REPOSITORY,
      useFactory: (prisma: PrismaService) => new PrismaCustomerRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: VERIFICATION_REQUEST_REPOSITORY,
      useFactory: (prisma: PrismaService) => new PrismaVerificationRequestRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: DOCUMENT_REPOSITORY,
      useFactory: (prisma: PrismaService) => new PrismaDocumentRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: AUDIT_TRAIL_PORT,
      useFactory: (prisma: PrismaService, enc: EncryptionService) =>
        new PrismaAuditEventRepository(prisma, enc),
      inject: [PrismaService, EncryptionService],
    },
  ],
  exports: [
    PrismaService,
    EncryptionService,
    KMS_PORT,
    CUSTOMER_REPOSITORY,
    VERIFICATION_REQUEST_REPOSITORY,
    DOCUMENT_REPOSITORY,
    AUDIT_TRAIL_PORT,
  ],
})
export class PersistenceModule {}
