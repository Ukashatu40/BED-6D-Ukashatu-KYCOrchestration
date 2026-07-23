// src/api/webhooks/webhooks.module.ts
import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { ProcessWebhookUseCase } from '../../application/use-cases/process-webhook.use-case';
import {
  AUDIT_TRAIL_PORT,
  CUSTOMER_REPOSITORY,
  VERIFICATION_REQUEST_REPOSITORY,
} from '../../infrastructure/persistence/tokens';
import {
  NOTIFICATION_PORT,
  TIMER_SERVICE,
  VENDOR_FACTORY,
  WORKFLOW_CONFIG_PROVIDER,
} from '../shared.tokens';
import { CustomerRepositoryPort } from '../../application/ports/customer-repository.port';
import { VerificationRequestRepositoryPort } from '../../application/ports/verification-request-repository.port';
import { AuditTrailPort } from '../../application/ports/audit-trail.port';
import { InMemoryNotification } from '../../infrastructure/notification/in-memory-notification';
import { WorkflowConfigProvider } from '../../application/use-cases/initiate-kyc.use-case';
import { VendorAdapterFactory } from '../../infrastructure/vendors/vendor-adapter.factory';
import { TimerService } from '../../application/workflow-engine/timer.service';

@Module({
  controllers: [WebhooksController],
  providers: [
    {
      provide: 'ProcessWebhookUseCase',
      useFactory: (
        customerRepo: CustomerRepositoryPort,
        requestRepo: VerificationRequestRepositoryPort,
        auditTrail: AuditTrailPort,
        notifications: InMemoryNotification,
        configProvider: WorkflowConfigProvider,
        vendorFactory: VendorAdapterFactory,
        timerService: TimerService,
      ) =>
        new ProcessWebhookUseCase(
          customerRepo,
          requestRepo,
          auditTrail,
          notifications,
          configProvider,
          vendorFactory,
          timerService,
        ),
      inject: [
        CUSTOMER_REPOSITORY,
        VERIFICATION_REQUEST_REPOSITORY,
        AUDIT_TRAIL_PORT,
        NOTIFICATION_PORT,
        WORKFLOW_CONFIG_PROVIDER,
        VENDOR_FACTORY,
        TIMER_SERVICE,
      ],
    },
  ],
})
export class WebhooksModule {}
