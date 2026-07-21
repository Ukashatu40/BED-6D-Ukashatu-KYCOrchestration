// src/application/workflow-engine/state-machine-side-effects.spec.ts
import { createStateMachineSideEffectHandler } from './state-machine-side-effects';
import { InMemoryAuditTrail } from '../../infrastructure/audit/in-memory-audit-trail';
import { InMemoryNotification } from '../../infrastructure/notification/in-memory-notification';
import { AuditActorType } from '../../domain/entities/audit-event.entity';
import { VerificationEvent } from '../../domain/state-machine/verification-state-machine';
import { VerificationStatus } from '../../domain/value-objects/verification-status.enum';
import { describe, expect, it } from '@jest/globals';

const actor = {
  customerId: 'cust-001',
  actorId: 'system',
  actorType: AuditActorType.SYSTEM,
  correlationId: 'corr-001',
};

describe('createStateMachineSideEffectHandler', () => {
  it('records an audit event for every transition', async () => {
    const auditTrail = new InMemoryAuditTrail();
    const handler = createStateMachineSideEffectHandler(
      auditTrail,
      new InMemoryNotification(),
      actor,
    );
    await handler({
      event: VerificationEvent.KYC_INITIATED,
      fromState: VerificationStatus.NOT_STARTED,
      toState: VerificationStatus.INITIATED,
      guardContext: {},
    });
    expect(auditTrail.getEventsForCustomer('cust-001')).toHaveLength(1);
  });

  it('sends a notification for docs.requested', async () => {
    const notifications = new InMemoryNotification();
    const handler = createStateMachineSideEffectHandler(
      new InMemoryAuditTrail(),
      notifications,
      actor,
    );
    await handler({
      event: VerificationEvent.DOCS_REQUESTED,
      fromState: VerificationStatus.INITIATED,
      toState: VerificationStatus.DOCUMENTS_PENDING,
      guardContext: {},
    });
    expect(notifications.sent).toHaveLength(1);
  });

  it('does not send a notification for a non-notifying event (e.g. step.passed)', async () => {
    const notifications = new InMemoryNotification();
    const handler = createStateMachineSideEffectHandler(
      new InMemoryAuditTrail(),
      notifications,
      actor,
    );
    await handler({
      event: VerificationEvent.STEP_PASSED,
      fromState: VerificationStatus.VERIFICATION_IN_PROGRESS,
      toState: VerificationStatus.VERIFICATION_IN_PROGRESS,
      guardContext: {},
    });
    expect(notifications.sent).toHaveLength(0);
  });
});
