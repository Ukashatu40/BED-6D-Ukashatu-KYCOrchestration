// src/api/aml/aml.module.ts
import { Module } from '@nestjs/common';
import { AmlController } from './aml.controller';
import { DisposeAmlAlertUseCase } from '../../application/use-cases/dispose-aml-alert.use-case';
import { AUDIT_TRAIL_PORT } from '../../infrastructure/persistence/tokens';
import { AML_MATCH_REPOSITORY } from '../shared.tokens';
import { AuditTrailPort } from '../../application/ports/audit-trail.port';
import { AmlMatchRepositoryPort } from '../../application/use-cases/dispose-aml-alert.use-case';

/**
 * AML_MATCH_REPOSITORY has no concrete Prisma-backed provider yet — see
 * Day 5 status notes ("AmlMatchRepository — currently a port with no
 * concrete Day 4-style adapter"). Registered here as an in-memory stub so
 * the module boots and the disposition use case is reachable end-to-end
 * via HTTP; a real deployment needs this backed by aml_match_details
 * (the table already exists in the Prisma schema from Day 4 — only the
 * repository class implementing AmlMatchRepositoryPort against it is
 * missing).
 */
class InMemoryAmlMatchRepository implements AmlMatchRepositoryPort {
  private matches = new Map<
    string,
    { matchId: string; customerId: string; matchedName: string; matchConfidence: number }
  >();
  async findMatchById(matchId: string) {
    return this.matches.get(matchId) ?? null;
  }
  async saveDisposition(): Promise<void> {
    // no-op stub — see class-level note
  }
  /** Test/demo seeding helper — not part of the port interface. */
  seed(m: { matchId: string; customerId: string; matchedName: string; matchConfidence: number }) {
    this.matches.set(m.matchId, m);
  }
}

@Module({
  controllers: [AmlController],
  providers: [
    { provide: AML_MATCH_REPOSITORY, useClass: InMemoryAmlMatchRepository },
    {
      provide: 'DisposeAmlAlertUseCase',
      useFactory: (amlRepo: AmlMatchRepositoryPort, auditTrail: AuditTrailPort) =>
        new DisposeAmlAlertUseCase(amlRepo, auditTrail),
      inject: [AML_MATCH_REPOSITORY, AUDIT_TRAIL_PORT],
    },
  ],
  exports: [AML_MATCH_REPOSITORY],
})
export class AmlModule {}
