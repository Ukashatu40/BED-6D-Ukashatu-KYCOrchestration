// src/application/ports/audit-trail.port.ts
import { AuditActorType, AuditEvent } from '../../domain/entities/audit-event.entity';

export interface RecordAuditEventParams {
  customerId: string | null;
  eventType: string;
  actorType: AuditActorType;
  actorId: string;
  correlationId: string;
  eventPayload: Record<string, unknown>;
}

/**
 * Boundary for writing to the immutable, hash-chained audit trail. Real
 * implementation (AuditEventRepository, built later this Day 4) enforces
 * append-only semantics at the DB role level and correctly threads
 * previous_event_hash per customer. This port lets DocumentStorageService
 * and every other audit-emitting component be written and tested today
 * without waiting on the Postgres schema.
 */
export interface AuditTrailPort {
  recordEvent(params: RecordAuditEventParams): Promise<AuditEvent>;
}
