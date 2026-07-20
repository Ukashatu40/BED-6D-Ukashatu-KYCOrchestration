// src/infrastructure/audit/prisma-audit-event.repository.ts
import { AuditActorType, AuditEvent } from '../../domain/entities/audit-event.entity';
import { AuditTrailPort, RecordAuditEventParams } from '../../application/ports/audit-trail.port';
import { EncryptionService } from '../encryption/encryption.service';
import { PrismaService } from '../persistence/prisma.service';
import type { AuditEvent as PrismaAuditEventRow } from '@prisma/client';

export interface AuditEventQueryFilters {
  customerId?: string;
  eventType?: string;
  dateFrom?: Date;
  dateTo?: Date;
  actorId?: string;
}

/**
 * Prisma-backed AuditTrailPort. Deliberately exposes ONLY recordEvent()
 * (an insert) and query methods (reads) — there is no updateEvent() or
 * deleteEvent() method anywhere on this class, matching the spec's
 * "AuditEventRepository must enforce append-only semantics... it exposes
 * only save() and find() methods" (p.37), reinforced at the DB level by
 * the trg_audit_events_no_update/no_delete triggers from the schema
 * migration. Two independent layers enforcing the same invariant.
 *
 * Handles the one piece of real complexity beyond persistence: the audit
 * payload is PII-bearing and must be encrypted at rest (see schema
 * commit's deviation note), but the hash chain (AuditEvent.computeHash)
 * must be computed over the PLAINTEXT payload — hashing ciphertext instead
 * would make the hash chain verify successfully even after ciphertext
 * corruption unrelated to the actual event content, defeating its purpose.
 * So: hash first (in the domain layer, Day 1's AuditEvent.create), encrypt
 * second (here, at the persistence boundary).
 */
export class PrismaAuditEventRepository implements AuditTrailPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
  ) {}

  async recordEvent(params: RecordAuditEventParams): Promise<AuditEvent> {
    const previousEventHash = await this.getLastEventHash(params.customerId);

    // Hashing happens over the plaintext payload, inside AuditEvent.create —
    // this is the domain entity from Day 1, untouched. Only the eventual
    // Prisma write encrypts eventPayload; the in-memory AuditEvent object
    // returned to the caller still carries the plaintext payload and the
    // hash computed from it.
    const { randomUUID } = await import('crypto');
    const event = AuditEvent.create({
      eventId: randomUUID(),
      customerId: params.customerId,
      eventType: params.eventType,
      eventVersion: 1,
      actorType: params.actorType,
      actorId: params.actorId,
      correlationId: params.correlationId,
      eventPayload: params.eventPayload,
      previousEventHash,
    });

    const props = event.toProps();
    const encryptedPayload = await this.encryptionService.encryptDocument(
      Buffer.from(JSON.stringify(props.eventPayload)),
    );

    await this.prisma.auditEvent.create({
      data: {
        eventId: props.eventId,
        customerId: props.customerId,
        eventType: props.eventType,
        eventVersion: props.eventVersion,
        actorType: props.actorType as AuditActorType,
        actorId: props.actorId,
        correlationId: props.correlationId,
        // Envelope-encrypted payload is serialised into the single
        // event_payload_encrypted BYTEA column as JSON of its four parts —
        // simplest approach that keeps the schema's one-column shape
        // rather than adding four new columns the spec's table doesn't list.
        eventPayloadEncrypted: this.serialiseEnvelope(encryptedPayload),
        previousEventHash: props.previousEventHash,
        eventHash: props.eventHash,
        createdAt: props.createdAt,
      },
    });

    return event;
  }

  async findByCustomer(
    customerId: string,
    filters: Omit<AuditEventQueryFilters, 'customerId'> = {},
  ): Promise<AuditEvent[]> {
    const rows = await this.prisma.auditEvent.findMany({
      where: {
        customerId,
        eventType: filters.eventType,
        actorId: filters.actorId,
        createdAt: {
          gte: filters.dateFrom,
          lte: filters.dateTo,
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(rows.map((row) => this.toDomain(row)));
  }

  /** Walks a customer's full chain and verifies every event's hash against its recomputed value AND that each event's previousEventHash matches its predecessor's actual hash — catches both single-event tampering and chain-splicing (an event deleted/reordered). */
  async verifyChainIntegrity(
    customerId: string,
  ): Promise<{ valid: boolean; brokenAtEventId: string | null }> {
    const events = await this.findByCustomer(customerId);
    let expectedPreviousHash: string | null = null;

    for (const event of events) {
      const props = event.toProps();
      if (!event.verifyOwnIntegrity()) {
        return { valid: false, brokenAtEventId: props.eventId };
      }
      if (props.previousEventHash !== expectedPreviousHash) {
        return { valid: false, brokenAtEventId: props.eventId };
      }
      expectedPreviousHash = props.eventHash;
    }

    return { valid: true, brokenAtEventId: null };
  }

  private async getLastEventHash(customerId: string | null): Promise<string | null> {
    if (!customerId) return null; // system-wide events don't chain per-customer
    const last = await this.prisma.auditEvent.findFirst({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
    });
    return last?.eventHash ?? null;
  }

  private serialiseEnvelope(envelope: {
    ciphertext: Buffer;
    iv: Buffer;
    authTag: Buffer;
    encryptedDek: Buffer;
    kekVersion: string;
  }): Buffer {
    return Buffer.from(
      JSON.stringify({
        ciphertext: envelope.ciphertext.toString('base64'),
        iv: envelope.iv.toString('base64'),
        authTag: envelope.authTag.toString('base64'),
        encryptedDek: envelope.encryptedDek.toString('base64'),
        kekVersion: envelope.kekVersion,
      }),
    );
  }

  private deserialiseEnvelope(serialised: Buffer): {
    ciphertext: Buffer;
    iv: Buffer;
    authTag: Buffer;
    encryptedDek: Buffer;
    kekVersion: string;
  } {
    const parsed = JSON.parse(serialised.toString('utf-8'));
    return {
      ciphertext: Buffer.from(parsed.ciphertext, 'base64'),
      iv: Buffer.from(parsed.iv, 'base64'),
      authTag: Buffer.from(parsed.authTag, 'base64'),
      encryptedDek: Buffer.from(parsed.encryptedDek, 'base64'),
      kekVersion: parsed.kekVersion,
    };
  }

  private async toDomain(row: PrismaAuditEventRow): Promise<AuditEvent> {
    const envelope = this.deserialiseEnvelope(Buffer.from(row.eventPayloadEncrypted));
    const decryptedPayload = await this.encryptionService.decryptDocument(envelope);
    return AuditEvent.reconstitute({
      eventId: row.eventId,
      customerId: row.customerId,
      eventType: row.eventType,
      eventVersion: row.eventVersion,
      actorType: row.actorType as unknown as AuditActorType,
      actorId: row.actorId,
      correlationId: row.correlationId,
      eventPayload: JSON.parse(decryptedPayload.toString('utf-8')),
      previousEventHash: row.previousEventHash,
      eventHash: row.eventHash,
      createdAt: row.createdAt,
    });
  }
}
