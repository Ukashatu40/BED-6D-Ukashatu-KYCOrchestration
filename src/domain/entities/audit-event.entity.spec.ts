// src/domain/entities/audit-event.entity.spec.ts
import { AuditEvent, AuditActorType } from './audit-event.entity';
import { describe, it, expect } from '@jest/globals';

describe('AuditEvent tamper-evident hashing', () => {
  it('produces a verifiable hash on creation', () => {
    const event = AuditEvent.create({
      eventId: 'evt-001',
      customerId: 'cust-001',
      eventType: 'KycInitiated',
      eventVersion: 1,
      actorType: AuditActorType.SYSTEM,
      actorId: 'orchestration-engine',
      correlationId: 'corr-001',
      eventPayload: { tier: 'MINIMUM' },
      previousEventHash: null,
    });
    expect(event.verifyOwnIntegrity()).toBe(true);
  });

  it('detects tampering when payload is altered post-hoc', () => {
    const event = AuditEvent.create({
      eventId: 'evt-002',
      customerId: 'cust-001',
      eventType: 'DocumentUploaded',
      eventVersion: 1,
      actorType: AuditActorType.USER,
      actorId: 'cust-001',
      correlationId: 'corr-002',
      eventPayload: { documentType: 'AADHAAR' },
      previousEventHash: null,
    });
    const tampered = AuditEvent.reconstitute({
      ...event.toProps(),
      eventPayload: { documentType: 'PAN' }, // tampered after the fact
    });
    expect(tampered.verifyOwnIntegrity()).toBe(false);
  });

  it('chains correctly to a previous event hash', () => {
    const first = AuditEvent.create({
      eventId: 'evt-003',
      customerId: 'cust-002',
      eventType: 'KycInitiated',
      eventVersion: 1,
      actorType: AuditActorType.SYSTEM,
      actorId: 'system',
      correlationId: 'corr-003',
      eventPayload: {},
      previousEventHash: null,
    });
    const second = AuditEvent.create({
      eventId: 'evt-004',
      customerId: 'cust-002',
      eventType: 'DocumentUploaded',
      eventVersion: 1,
      actorType: AuditActorType.USER,
      actorId: 'cust-002',
      correlationId: 'corr-004',
      eventPayload: {},
      previousEventHash: first.eventHash,
    });
    expect(second.previousEventHash).toBe(first.eventHash);
    expect(second.verifyOwnIntegrity()).toBe(true);
  });
});
