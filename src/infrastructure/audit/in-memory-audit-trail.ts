// src/infrastructure/audit/in-memory-audit-trail.ts
import { AuditEvent } from '../../domain/entities/audit-event.entity';
import { AuditTrailPort, RecordAuditEventParams } from '../../application/ports/audit-trail.port';

/**
 * Test/dev fake — but exercises the SAME hash-chaining logic
 * (AuditEvent.create with previousEventHash threading) the real
 * Postgres-backed AuditEventRepository will use, per customer. This means
 * tests written against this fake today (DocumentStorageService's, and
 * later use-case tests) already validate hash-chain correctness, not just
 * "a record got saved somewhere."
 */
export class InMemoryAuditTrail implements AuditTrailPort {
  private readonly eventsByCustomer = new Map<string, AuditEvent[]>();
  private eventCounter = 0;

  async recordEvent(params: RecordAuditEventParams): Promise<AuditEvent> {
    const key = params.customerId ?? '__system__';
    const priorEvents = this.eventsByCustomer.get(key) ?? [];
    const previousEventHash =
      priorEvents.length > 0 ? priorEvents[priorEvents.length - 1].eventHash : null;

    this.eventCounter += 1;
    const event = AuditEvent.create({
      eventId: `evt-${this.eventCounter}`,
      customerId: params.customerId,
      eventType: params.eventType,
      eventVersion: 1,
      actorType: params.actorType,
      actorId: params.actorId,
      correlationId: params.correlationId,
      eventPayload: params.eventPayload,
      previousEventHash,
    });

    this.eventsByCustomer.set(key, [...priorEvents, event]);
    return event;
  }

  /** Test helper — not part of AuditTrailPort. */
  getEventsForCustomer(customerId: string): AuditEvent[] {
    return this.eventsByCustomer.get(customerId) ?? [];
  }
}
