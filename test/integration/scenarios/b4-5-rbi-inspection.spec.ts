// test/integration/scenarios/b4-5-rbi-inspection.spec.ts
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../src/infrastructure/persistence/prisma.service';
import { PrismaAuditEventRepository } from '../../../src/infrastructure/audit/prisma-audit-event.repository';
import { EncryptionService } from '../../../src/infrastructure/encryption/encryption.service';
import { InMemoryKms } from '../../../src/infrastructure/encryption/in-memory-kms';
import { AuditActorType } from '../../../src/domain/entities/audit-event.entity';
import { describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals';

/**
 * Models Section B4.5: an RBI inspection team requesting the complete
 * audit trail for a customer, wanting verification steps, document
 * uploads, vendor interactions, state transitions, and hash-chain
 * integrity — producible within a 2-hour SLA (2.4 min/customer for 50
 * customers). This scenario tests the audit trail's own guarantees
 * directly: completeness (every event type the spec lists gets captured),
 * chronological ordering, and — the requirement given the most weight in
 * the spec's own evaluation criteria — hash chain integrity verification,
 * including correctly detecting tampering rather than just trusting the
 * database blindly.
 */
describe('Scenario B4.5 — RBI On-Site Inspection', () => {
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
    await prisma.customer.deleteMany({});
  });

  const actor = {
    actorType: AuditActorType.SYSTEM,
    actorId: 'test-system',
    correlationId: 'corr-b45',
  };

  async function seedCustomer(): Promise<string> {
    const customerId = randomUUID();
    await prisma.customer.create({
      data: {
        customerId,
        externalId: `ext-${randomUUID()}`,
        fullNameEncrypted: Buffer.from('x'),
        dateOfBirthEncrypted: Buffer.from('x'),
        kycTier: 'FULL',
        kycStatus: 'VERIFIED',
        riskScore: 20,
        riskFactors: {},
      },
    });
    return customerId;
  }

  it('produces the complete timeline from first contact to current status, in chronological order', async () => {
    const customerId = await seedCustomer();
    const eventSequence = [
      'KycInitiated',
      'DocumentUploaded',
      'DocumentEncrypted',
      'AmlScreeningCompleted',
      'RiskScoreCalculated',
      'KycApproved',
    ];
    for (const eventType of eventSequence) {
      await repository.recordEvent({ customerId, eventType, ...actor, eventPayload: {} });
    }
    const timeline = await repository.findByCustomer(customerId);
    expect(timeline.map((e) => e.toProps().eventType)).toEqual(eventSequence);
  });

  it('captures all verification steps attempted, successful and failed, distinguishably', async () => {
    const customerId = await seedCustomer();
    await repository.recordEvent({
      customerId,
      eventType: 'VendorVerificationRequested',
      ...actor,
      eventPayload: { vendor: 'DIGILOCKER', step: 1 },
    });
    await repository.recordEvent({
      customerId,
      eventType: 'VendorTimeoutOccurred',
      ...actor,
      eventPayload: { vendor: 'CKYC', step: 2 },
    });
    await repository.recordEvent({
      customerId,
      eventType: 'VendorResponseReceived',
      ...actor,
      eventPayload: { vendor: 'CKYC', step: 2, retried: true },
    });

    const timeoutEvents = await repository.findByCustomer(customerId, {
      eventType: 'VendorTimeoutOccurred',
    });
    const successEvents = await repository.findByCustomer(customerId, {
      eventType: 'VendorResponseReceived',
    });
    expect(timeoutEvents).toHaveLength(1);
    expect(successEvents).toHaveLength(1);
  });

  it('supports query by date range for a specific inspection window', async () => {
    const customerId = await seedCustomer();
    await repository.recordEvent({
      customerId,
      eventType: 'KycInitiated',
      ...actor,
      eventPayload: {},
    });
    const midpoint = new Date();
    await new Promise((r) => setTimeout(r, 10));
    await repository.recordEvent({
      customerId,
      eventType: 'KycApproved',
      ...actor,
      eventPayload: {},
    });

    const eventsAfterMidpoint = await repository.findByCustomer(customerId, { dateFrom: midpoint });
    expect(eventsAfterMidpoint).toHaveLength(1);
    expect(eventsAfterMidpoint[0].toProps().eventType).toBe('KycApproved');
  });

  it('produces a passing hash chain verification for an untampered customer record', async () => {
    const customerId = await seedCustomer();
    for (const eventType of ['KycInitiated', 'DocumentUploaded', 'KycApproved']) {
      await repository.recordEvent({ customerId, eventType, ...actor, eventPayload: {} });
    }
    const result = await repository.verifyChainIntegrity(customerId);
    expect(result.valid).toBe(true);
  });

  it('flags tampered records rather than passing an inspection silently', async () => {
    const customerId = await seedCustomer();
    const event = await repository.recordEvent({
      customerId,
      eventType: 'KycApproved',
      ...actor,
      eventPayload: {},
    });
    await prisma.$executeRawUnsafe(
      'ALTER TABLE audit_events DISABLE TRIGGER trg_audit_events_no_update',
    );
    await prisma.$executeRawUnsafe(
      `UPDATE audit_events SET event_hash = 'deadbeef0000000000000000000000000000000000000000000000000000' WHERE event_id = $1`,
      event.toProps().eventId,
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE audit_events ENABLE TRIGGER trg_audit_events_no_update',
    );

    const result = await repository.verifyChainIntegrity(customerId);
    expect(result.valid).toBe(false);
    expect(result.brokenAtEventId).toBe(event.toProps().eventId);
  });

  it('meets the per-customer report generation performance budget (well under the 2.4 min/customer target for a realistic event volume)', async () => {
    const customerId = await seedCustomer();
    for (let i = 0; i < 50; i++) {
      await repository.recordEvent({
        customerId,
        eventType: `Event${i}`,
        ...actor,
        eventPayload: { index: i },
      });
    }
    const start = Date.now();
    const timeline = await repository.findByCustomer(customerId);
    const verification = await repository.verifyChainIntegrity(customerId);
    const elapsedMs = Date.now() - start;

    expect(timeline).toHaveLength(50);
    expect(verification.valid).toBe(true);
    expect(elapsedMs).toBeLessThan(2.4 * 60 * 1000); // spec's 2.4 min/customer budget — trivially met, but asserted explicitly
  });
});
