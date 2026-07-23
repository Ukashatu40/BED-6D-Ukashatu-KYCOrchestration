// src/api/data-erasure/data-erasure.module.ts
import { Module } from '@nestjs/common';
import { DataErasureController } from './data-erasure.controller';
import { RequestDataErasureUseCase } from '../../application/use-cases/request-data-erasure.use-case';
import { InMemoryDataErasureRepository } from '../../infrastructure/persistence/in-memory-data-erasure-repository';
import { AUDIT_TRAIL_PORT, CUSTOMER_REPOSITORY } from '../../infrastructure/persistence/tokens';
import { DATA_ERASURE_REPOSITORY, TIMER_SERVICE } from '../shared.tokens';
import { CustomerRepositoryPort } from '../../application/ports/customer-repository.port';
import { AuditTrailPort } from '../../application/ports/audit-trail.port';
import { TimerService } from '../../application/workflow-engine/timer.service';
import { DataErasureRepositoryPort } from '../../application/ports/data-erasure-repository.port';

@Module({
  controllers: [DataErasureController],
  providers: [
    { provide: DATA_ERASURE_REPOSITORY, useClass: InMemoryDataErasureRepository },
    {
      provide: 'RequestDataErasureUseCase',
      useFactory: (
        customerRepo: CustomerRepositoryPort,
        erasureRepo: DataErasureRepositoryPort,
        auditTrail: AuditTrailPort,
        timerService: TimerService,
      ) => new RequestDataErasureUseCase(customerRepo, erasureRepo, auditTrail, timerService),
      inject: [CUSTOMER_REPOSITORY, DATA_ERASURE_REPOSITORY, AUDIT_TRAIL_PORT, TIMER_SERVICE],
    },
  ],
})
export class DataErasureModule {}
