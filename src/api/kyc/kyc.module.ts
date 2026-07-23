// src/api/kyc/kyc.module.ts
import { Module } from '@nestjs/common';
import { KycController } from './kyc.controller';
import {
  InitiateKycUseCase,
  WorkflowConfigProvider,
} from '../../application/use-cases/initiate-kyc.use-case';
import { UploadKycDocumentUseCase } from '../../application/use-cases/upload-kyc-document.use-case';
import { GetKycStatusUseCase } from '../../application/use-cases/get-kyc-status.use-case';
import { GetKycHistoryUseCase } from '../../application/use-cases/get-kyc-history.use-case';
import { EscalateKycTierUseCase } from '../../application/use-cases/escalate-kyc-tier.use-case';
import { DocumentStorageService } from '../../infrastructure/storage/document-storage.service';
import { TimerService } from '../../application/workflow-engine/timer.service';
import { VendorAdapterFactory } from '../../infrastructure/vendors/vendor-adapter.factory';
import { InMemoryNotification } from '../../infrastructure/notification/in-memory-notification';
import { InMemoryTimerRepository } from '../../infrastructure/persistence/in-memory-timer-repository';
import { InMemoryObjectStore } from '../../infrastructure/storage/in-memory-object-store';
import {
  NOTIFICATION_PORT,
  TIMER_SERVICE,
  VENDOR_FACTORY,
  WORKFLOW_CONFIG_PROVIDER,
} from '../shared.tokens';
import {
  AUDIT_TRAIL_PORT,
  CUSTOMER_REPOSITORY,
  DOCUMENT_REPOSITORY,
  VERIFICATION_REQUEST_REPOSITORY,
} from '../../infrastructure/persistence/tokens';
import { CustomerRepositoryPort } from '../../application/ports/customer-repository.port';
import { VerificationRequestRepositoryPort } from '../../application/ports/verification-request-repository.port';
import { DocumentRepositoryPort } from '../../application/ports/document-repository.port';
import { AuditTrailPort } from '../../application/ports/audit-trail.port';
import { EncryptionService } from '../../infrastructure/encryption/encryption.service';

/**
 * Wires KycController's four use cases. NotificationPort, TimerService's
 * repository, and the object store are still in-memory (InMemoryNotification,
 * InMemoryTimerRepository, InMemoryObjectStore) — Prisma-backed/S3-backed
 * versions of these three are explicitly flagged as Day 6+ hardening not
 * yet built (see Day 5's status notes). This means e2e tests exercise real
 * HTTP + real Postgres for everything EXCEPT notification delivery, timer
 * persistence across restarts, and document blob storage, which stay
 * process-local. Acceptable for demonstrating the wiring; a genuine
 * production deployment needs all three swapped before going live.
 */
@Module({
  controllers: [KycController],
  providers: [
    {
      provide: 'InitiateKycUseCase',
      useFactory: (
        customerRepo: CustomerRepositoryPort,
        requestRepo: VerificationRequestRepositoryPort,
        auditTrail: AuditTrailPort,
        notifications: InMemoryNotification,
        configProvider: WorkflowConfigProvider,
      ) =>
        new InitiateKycUseCase(
          customerRepo,
          requestRepo,
          auditTrail,
          notifications,
          configProvider,
        ),
      inject: [
        CUSTOMER_REPOSITORY,
        VERIFICATION_REQUEST_REPOSITORY,
        AUDIT_TRAIL_PORT,
        NOTIFICATION_PORT,
        WORKFLOW_CONFIG_PROVIDER,
      ],
    },
    {
      provide: 'UploadKycDocumentUseCase',
      useFactory: (
        customerRepo: CustomerRepositoryPort,
        requestRepo: VerificationRequestRepositoryPort,
        documentRepo: DocumentRepositoryPort,
        encryptionService: EncryptionService,
        auditTrail: AuditTrailPort,
        notifications: InMemoryNotification,
        configProvider: WorkflowConfigProvider,
        vendorFactory: VendorAdapterFactory,
        timerService: TimerService,
      ) => {
        const storage = new DocumentStorageService(
          encryptionService,
          new InMemoryObjectStore(),
          documentRepo,
          auditTrail,
        );
        return new UploadKycDocumentUseCase(
          customerRepo,
          requestRepo,
          documentRepo,
          storage,
          auditTrail,
          notifications,
          configProvider,
          vendorFactory,
          timerService,
        );
      },
      inject: [
        CUSTOMER_REPOSITORY,
        VERIFICATION_REQUEST_REPOSITORY,
        DOCUMENT_REPOSITORY,
        EncryptionService,
        AUDIT_TRAIL_PORT,
        NOTIFICATION_PORT,
        WORKFLOW_CONFIG_PROVIDER,
        VENDOR_FACTORY,
        TIMER_SERVICE,
      ],
    },
    {
      provide: 'GetKycStatusUseCase',
      useFactory: (requestRepo: VerificationRequestRepositoryPort) =>
        new GetKycStatusUseCase(requestRepo),
      inject: [VERIFICATION_REQUEST_REPOSITORY],
    },
    {
      provide: 'GetKycHistoryUseCase',
      useFactory: (auditRepo: any) => new GetKycHistoryUseCase(auditRepo),
      inject: [AUDIT_TRAIL_PORT],
    },
    {
      provide: 'EscalateKycTierUseCase',
      useFactory: (
        requestRepo: VerificationRequestRepositoryPort,
        customerRepo: CustomerRepositoryPort,
        auditTrail: AuditTrailPort,
      ) => new EscalateKycTierUseCase(requestRepo, customerRepo, auditTrail),
      inject: [VERIFICATION_REQUEST_REPOSITORY, CUSTOMER_REPOSITORY, AUDIT_TRAIL_PORT],
    },
  ],
})
export class KycModule {}
