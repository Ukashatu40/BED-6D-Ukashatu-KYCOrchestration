import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../src/infrastructure/persistence/prisma.service';
import { PrismaAuditEventRepository } from '../../src/infrastructure/audit/prisma-audit-event.repository';
import { EncryptionService } from '../../src/infrastructure/encryption/encryption.service';
import { InMemoryKms } from '../../src/infrastructure/encryption/in-memory-kms';
import { AuditActorType } from '../../src/domain/entities/audit-event.entity';
import { expect, it, beforeAll, afterAll, afterEach, describe } from '@jest/globals';
import { v4 as uuidv4 } from 'uuid';

describe('PrismaAuditEventRepository (integration)', () => {
  let prisma: PrismaService;
  let repository: PrismaAuditEventRepository;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    repository = new PrismaAuditEventRepository(prisma, new EncryptionService(new InMemoryKms()));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE audit_events DISABLE TRIGGER trg_audit_events_no_delete',
    );
    await prisma.$executeRawUnsafe('TRUNCATE audit_events');
    await prisma.$executeRawUnsafe(
      'ALTER TABLE audit_events ENABLE TRIGGER trg_audit_events_no_delete',
    );
    // customers must be cleaned after audit_events since nothing FKs from
    // customers back to audit_events, but audit_events FKs to customers —
    // truncating customers first would itself fail on the FK.
    await prisma.customer.deleteMany({});
  });

  const actor = {
    actorType: AuditActorType.SYSTEM,
    actorId: uuidv4(),
    correlationId: uuidv4(),
  };

  /**
   * audit_events.customer_id is a UUID foreign key into customers —
   * every test needs a real, persisted Customer row to reference, not
   * just a syntactically valid UUID. Returns the generated customerId.
   */
  async function seedCustomer(): Promise<string> {
    const customerId = randomUUID();
    await prisma.customer.create({
      data: {
        customerId,
        externalId: `ext-${randomUUID()}`,
        fullNameEncrypted: Buffer.from('encrypted-name'),
        dateOfBirthEncrypted: Buffer.from('encrypted-dob'),
        kycTier: 'MINIMUM',
        kycStatus: 'NOT_STARTED',
        riskScore: 0,
        riskFactors: {},
      },
    });
    return customerId;
  }

  it('persists an event and reconstructs it with the exact original payload after decryption', async () => {
    const customerId = await seedCustomer();
    await repository.recordEvent({
      customerId,
      eventType: 'KycInitiated',
      ...actor,
      eventPayload: { tier: 'MINIMUM', name: 'Test Customer' },
    });
    const events = await repository.findByCustomer(customerId);
    expect(events).toHaveLength(1);
    expect(events[0].toProps().eventPayload).toEqual({ tier: 'MINIMUM', name: 'Test Customer' });
  });

  it('encrypts the payload at rest — raw DB column does not contain plaintext', async () => {
    const customerId = await seedCustomer();
    await repository.recordEvent({
      customerId,
      eventType: 'DocumentUploaded',
      ...actor,
      eventPayload: { documentType: 'AADHAAR', name: 'Sensitive Plaintext Name' },
    });
    const raw = await prisma.auditEvent.findFirst({ where: { customerId } });
    const rawColumnAsString = Buffer.from(raw!.eventPayloadEncrypted).toString('utf-8');
    expect(rawColumnAsString).not.toContain('Sensitive Plaintext Name');
  });

  it('threads previousEventHash correctly across successive events for the same customer', async () => {
    const customerId = await seedCustomer();
    const first = await repository.recordEvent({
      customerId,
      eventType: 'KycInitiated',
      ...actor,
      eventPayload: {},
    });
    const second = await repository.recordEvent({
      customerId,
      eventType: 'DocumentUploaded',
      ...actor,
      eventPayload: {},
    });
    expect(second.previousEventHash).toBe(first.eventHash);
  });

  it('does not chain events across different customers', async () => {
    const customerA = await seedCustomer();
    const customerB = await seedCustomer();
    await repository.recordEvent({
      customerId: customerA,
      eventType: 'KycInitiated',
      ...actor,
      eventPayload: {},
    });
    const otherCustomerEvent = await repository.recordEvent({
      customerId: customerB,
      eventType: 'KycInitiated',
      ...actor,
      eventPayload: {},
    });
    expect(otherCustomerEvent.previousEventHash).toBeNull();
  });

  it('filters findByCustomer by eventType', async () => {
    const customerId = await seedCustomer();
    await repository.recordEvent({
      customerId,
      eventType: 'KycInitiated',
      ...actor,
      eventPayload: {},
    });
    await repository.recordEvent({
      customerId,
      eventType: 'DocumentUploaded',
      ...actor,
      eventPayload: {},
    });
    const filtered = await repository.findByCustomer(customerId, { eventType: 'DocumentUploaded' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].toProps().eventType).toBe('DocumentUploaded');
  });

  describe('verifyChainIntegrity', () => {
    it('reports a valid chain for untampered events', async () => {
      const customerId = await seedCustomer();
      await repository.recordEvent({ customerId, eventType: 'A', ...actor, eventPayload: {} });
      await repository.recordEvent({ customerId, eventType: 'B', ...actor, eventPayload: {} });
      const result = await repository.verifyChainIntegrity(customerId);
      expect(result.valid).toBe(true);
      expect(result.brokenAtEventId).toBeNull();
    });

    it('detects tampering when an event_hash is directly modified in the database', async () => {
      const customerId = await seedCustomer();
      const event = await repository.recordEvent({
        customerId,
        eventType: 'A',
        ...actor,
        eventPayload: {},
      });
      await prisma.$executeRawUnsafe(
        'ALTER TABLE audit_events DISABLE TRIGGER trg_audit_events_no_update',
      );
      await prisma.$executeRawUnsafe(
        `UPDATE audit_events SET event_hash = 'tampered0000000000000000000000000000000000000000000000000000' WHERE event_id = $1::uuid`,
        event.toProps().eventId,
      );
      await prisma.$executeRawUnsafe(
        'ALTER TABLE audit_events ENABLE TRIGGER trg_audit_events_no_update',
      );

      const result = await repository.verifyChainIntegrity(customerId);
      expect(result.valid).toBe(false);
      expect(result.brokenAtEventId).toBe(event.toProps().eventId);
    });

    it('detects a spliced chain when a middle event is deleted', async () => {
      const customerId = await seedCustomer();
      const first = await repository.recordEvent({
        customerId,
        eventType: 'A',
        ...actor,
        eventPayload: {},
      });
      const second = await repository.recordEvent({
        customerId,
        eventType: 'B',
        ...actor,
        eventPayload: {},
      });
      const third = await repository.recordEvent({
        customerId,
        eventType: 'C',
        ...actor,
        eventPayload: {},
      });

      await prisma.$executeRawUnsafe(
        'ALTER TABLE audit_events DISABLE TRIGGER trg_audit_events_no_delete',
      );
      await prisma.$executeRawUnsafe(
        'DELETE FROM audit_events WHERE event_id = $1::uuid',
        second.toProps().eventId,
      );
      await prisma.$executeRawUnsafe(
        'ALTER TABLE audit_events ENABLE TRIGGER trg_audit_events_no_delete',
      );

      const result = await repository.verifyChainIntegrity(customerId);
      expect(result.valid).toBe(false);
      expect(result.brokenAtEventId).toBe(third.toProps().eventId);
    });
  });

  describe('append-only enforcement (application layer)', () => {
    it('PrismaAuditEventRepository exposes no update or delete method', () => {
      const methodNames = Object.getOwnPropertyNames(PrismaAuditEventRepository.prototype);
      expect(methodNames).not.toContain('updateEvent');
      expect(methodNames).not.toContain('deleteEvent');
      expect(methodNames).not.toContain('update');
      expect(methodNames).not.toContain('delete');
    });

    it('a raw UPDATE attempt against audit_events is rejected by the DB trigger regardless of caller', async () => {
      const customerId = await seedCustomer();
      await repository.recordEvent({ customerId, eventType: 'A', ...actor, eventPayload: {} });
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE audit_events SET event_type = 'Tampered' WHERE customer_id = $1::uuid`,
          customerId,
        ),
      ).rejects.toThrow(/append-only/);
    });
  });
});
