// src/application/workflow-engine/state-machine-side-effects.ts
import { AuditActorType } from '../../domain/entities/audit-event.entity';
import { AuditTrailPort } from '../ports/audit-trail.port';
import { NotificationPort } from '../ports/notification.port';
import {
  SideEffectHandler,
  SideEffectParams,
} from '../../domain/state-machine/verification-state-machine';

export interface SideEffectActorContext {
  customerId: string;
  actorId: string;
  actorType: AuditActorType;
  correlationId: string;
}

/**
 * Every state transition writes an audit event (event type = the
 * transition's target state change, e.g. "StateTransition:INITIATED"),
 * and select transitions additionally trigger a customer notification —
 * matching the TRANSITIONS table's sideEffect column from Day 3
 * (AUDIT_EVENT_AND_START_WORKFLOW, NOTIFY_CUSTOMER, etc.), now given real
 * implementations instead of symbolic strings.
 */
export function createStateMachineSideEffectHandler(
  auditTrail: AuditTrailPort,
  notifications: NotificationPort,
  actor: SideEffectActorContext,
): SideEffectHandler {
  return async (params: SideEffectParams) => {
    await auditTrail.recordEvent({
      customerId: actor.customerId,
      eventType: `StateTransition:${params.fromState}->${params.toState}`,
      actorType: actor.actorType,
      actorId: actor.actorId,
      correlationId: actor.correlationId,
      eventPayload: { event: params.event, fromState: params.fromState, toState: params.toState },
    });

    const notifyingEvents = new Set([
      'docs.requested',
      'timer.48h',
      'callback.rcvd',
      'all.passed',
      'step.failed',
    ]);
    if (notifyingEvents.has(params.event)) {
      await notifications.send({
        customerId: actor.customerId,
        channel: 'IN_APP',
        templateId: `kyc-status-${params.toState.toLowerCase()}`,
        data: { requestId: actor.correlationId },
      });
    }
  };
}
