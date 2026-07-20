// test/integration/prisma-audit-event.repository.spec.ts
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../src/infrastructure/persistence/prisma.service';
import { PrismaAuditEventRepository } from '../../src/infrastructure/audit/prisma-audit-event.repository';
import { EncryptionService } from '../../src/infrastructure/encryption/encryption.service';
import { InMemoryKms } from '../../src/infrastructure/encryption/in-memory-kms';
import { AuditActorType } from '../../src/domain/entities/audit-event.entity';
import { expect, describe, it, beforeAll, afterAll, afterEach } from '@jest/globals';

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
    // Cleanup must go through raw SQL with the trigger temporarily
    // disabled — the append-only trigger correctly rejects DELETE from
    // the app role, so test cleanup uses a superuser-style truncate
    // instead, mirroring how you'd clean a test DB, never production.
    await prisma.$executeRawUnsafe(
      'ALTER TABLE audit_events DISABLE TRIGGER trg_audit_events_no_delete',
    );
    await prisma.$executeRawUnsafe('TRUNCATE audit_events');
    await prisma.$executeRawUnsafe(
      'ALTER TABLE audit_events ENABLE TRIGGER trg_audit_events_no_delete',
    );
  });

  const actor = {
    actorType: AuditActorType.SYSTEM,
    actorId: 'test-system',
    correlationId: 'corr-001',
  };

  it('persists an event and reconstructs it with the exact original payload after decryption', async () => {
    await repository.recordEvent({
      customerId: 'cust-int-001',
      eventType: 'KycInitiated',
      ...actor,
      eventPayload: { tier: 'MINIMUM', name: 'Test Customer' },
    });
    const events = await repository.findByCustomer('cust-int-001');
    expect(events).toHaveLength(1);
    expect(events[0].toProps().eventPayload).toEqual({ tier: 'MINIMUM', name: 'Test Customer' });
  });

  it('encrypts the payload at rest — raw DB column does not contain plaintext', async () => {
    await repository.recordEvent({
      customerId: 'cust-int-002',
      eventType: 'DocumentUploaded',
      ...actor,
      eventPayload: { documentType: 'AADHAAR', name: 'Sensitive Plaintext Name' },
    });
    const raw = await prisma.auditEvent.findFirst({ where: { customerId: 'cust-int-002' } });
    const rawColumnAsString = Buffer.from(raw!.eventPayloadEncrypted).toString('utf-8');
    expect(rawColumnAsString).not.toContain('Sensitive Plaintext Name');
  });

  it('threads previousEventHash correctly across successive events for the same customer', async () => {
    const first = await repository.recordEvent({
      customerId: 'cust-int-003',
      eventType: 'KycInitiated',
      ...actor,
      eventPayload: {},
    });
    const second = await repository.recordEvent({
      customerId: 'cust-int-003',
      eventType: 'DocumentUploaded',
      ...actor,
      eventPayload: {},
    });
    expect(second.previousEventHash).toBe(first.eventHash);
  });

  it('does not chain events across different customers', async () => {
    await repository.recordEvent({
      customerId: 'cust-int-004a',
      eventType: 'KycInitiated',
      ...actor,
      eventPayload: {},
    });
    const otherCustomerEvent = await repository.recordEvent({
      customerId: 'cust-int-004b',
      eventType: 'KycInitiated',
      ...actor,
      eventPayload: {},
    });
    expect(otherCustomerEvent.previousEventHash).toBeNull(); // first event for THIS customer
  });

  it('filters findByCustomer by eventType', async () => {
    await repository.recordEvent({
      customerId: 'cust-int-005',
      eventType: 'KycInitiated',
      ...actor,
      eventPayload: {},
    });
    await repository.recordEvent({
      customerId: 'cust-int-005',
      eventType: 'DocumentUploaded',
      ...actor,
      eventPayload: {},
    });
    const filtered = await repository.findByCustomer('cust-int-005', {
      eventType: 'DocumentUploaded',
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].toProps().eventType).toBe('DocumentUploaded');
  });

  describe('verifyChainIntegrity', () => {
    it('reports a valid chain for untampered events', async () => {
      await repository.recordEvent({
        customerId: 'cust-int-006',
        eventType: 'A',
        ...actor,
        eventPayload: {},
      });
      await repository.recordEvent({
        customerId: 'cust-int-006',
        eventType: 'B',
        ...actor,
        eventPayload: {},
      });
      const result = await repository.verifyChainIntegrity('cust-int-006');
      expect(result.valid).toBe(true);
      expect(result.brokenAtEventId).toBeNull();
    });

    it('detects tampering when an event_hash is directly modified in the database', async () => {
      const event = await repository.recordEvent({
        customerId: 'cust-int-007',
        eventType: 'A',
        ...actor,
        eventPayload: {},
      });
      // Simulate tampering: modify the stored hash directly via raw SQL,
      // bypassing the repository (the trigger blocks UPDATE from the app
      // role in production; this raw call models an attacker with elevated
      // access, which is exactly the threat the hash chain defends against).
      await prisma.$executeRawUnsafe(
        'ALTER TABLE audit_events DISABLE TRIGGER trg_audit_events_no_update',
      );
      await prisma.$executeRawUnsafe(
        `UPDATE audit_events SET event_hash = 'tampered0000000000000000000000000000000000000000000000000000' WHERE event_id = $1`,
        event.toProps().eventId,
      );
      await prisma.$executeRawUnsafe(
        'ALTER TABLE audit_events ENABLE TRIGGER trg_audit_events_no_update',
      );

      const result = await repository.verifyChainIntegrity('cust-int-007');
      expect(result.valid).toBe(false);
      expect(result.brokenAtEventId).toBe(event.toProps().eventId);
    });

    it('detects a spliced chain when a middle event is deleted', async () => {
      const first = await repository.recordEvent({
        customerId: 'cust-int-008',
        eventType: 'A',
        ...actor,
        eventPayload: {},
      });
      const second = await repository.recordEvent({
        customerId: 'cust-int-008',
        eventType: 'B',
        ...actor,
        eventPayload: {},
      });
      const third = await repository.recordEvent({
        customerId: 'cust-int-008',
        eventType: 'C',
        ...actor,
        eventPayload: {},
      });

      await prisma.$executeRawUnsafe(
        'ALTER TABLE audit_events DISABLE TRIGGER trg_audit_events_no_delete',
      );
      await prisma.$executeRawUnsafe(
        'DELETE FROM audit_events WHERE event_id = $1',
        second.toProps().eventId,
      );
      await prisma.$executeRawUnsafe(
        'ALTER TABLE audit_events ENABLE TRIGGER trg_audit_events_no_delete',
      );

      const result = await repository.verifyChainIntegrity('cust-int-008');
      expect(result.valid).toBe(false);
      expect(result.brokenAtEventId).toBe(third.toProps().eventId); // third's previousEventHash now points to a hash that no longer precedes it in the returned sequence
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
      await repository.recordEvent({
        customerId: 'cust-int-009',
        eventType: 'A',
        ...actor,
        eventPayload: {},
      });
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE audit_events SET event_type = 'Tampered' WHERE customer_id = $1`,
          'cust-int-009',
        ),
      ).rejects.toThrow(/append-only/);
    });
  });
});
