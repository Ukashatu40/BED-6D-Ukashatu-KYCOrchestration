// src/application/use-cases/get-kyc-history.use-case.ts
import { AuditTrailPort } from '../ports/audit-trail.port';

/**
 * Thin wrapper over AuditTrailPort.recordEvent's read-side counterpart.
 * Note: AuditTrailPort as defined (Day 4) only exposes recordEvent — the
 * query capability (findByCustomer, verifyChainIntegrity) lives on the
 * concrete PrismaAuditEventRepository, not the port interface itself.
 * This use case depends on the concrete repository type rather than the
 * port for that reason; widening AuditTrailPort to include query methods
 * is a reasonable Day 6+ cleanup but out of scope here since it would
 * ripple back through every other use case's constructor signature.
 */
export class GetKycHistoryUseCase {
  constructor(
    private readonly auditRepository: {
      findByCustomer: (customerId: string, filters?: object) => Promise<unknown[]>;
    },
  ) {}

  async execute(customerId: string) {
    const events = await this.auditRepository.findByCustomer(customerId);
    return { customerId, events };
  }
}
