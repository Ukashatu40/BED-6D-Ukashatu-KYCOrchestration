// src/application/use-cases/process-webhook.use-case.ts
import { AuditActorType } from '../../domain/entities/audit-event.entity';
import { VerificationStatus } from '../../domain/value-objects/verification-status.enum';
import { VerificationRequest } from '../../domain/entities/verification-request.entity';
import {
  VerificationEvent,
  VerificationStateMachine,
} from '../../domain/state-machine/verification-state-machine';
import { WorkflowEngine } from '../workflow-engine/workflow-engine';
import { VendorStepExecutor } from '../workflow-engine/vendor-step.executor';
import { createStateMachineSideEffectHandler } from '../workflow-engine/state-machine-side-effects';
import { TimerService } from '../workflow-engine/timer.service';
import { TimerType } from '../ports/timer-repository.port';
import { VendorType, WebhookPayload } from '../ports/kyc-vendor.port';
import { CustomerRepositoryPort } from '../ports/customer-repository.port';
import { VerificationRequestRepositoryPort } from '../ports/verification-request-repository.port';
import { AuditTrailPort } from '../ports/audit-trail.port';
import { NotificationPort } from '../ports/notification.port';
import { VendorAdapterFactory } from '../../infrastructure/vendors/vendor-adapter.factory';
import { WorkflowConfigProvider } from './initiate-kyc.use-case';

export class WebhookRequestNotFoundError extends Error {
  constructor(requestId: string) {
    super(`No verification request found for webhook correlation to requestId ${requestId}`);
    this.name = 'WebhookRequestNotFoundError';
  }
}

export interface ProcessWebhookCommand {
  vendorType: VendorType;
  requestId: string; // the orchestration's own requestId, resolved by the webhook controller from the vendor's session/reference ID before invoking this use case — see note below
  payload: WebhookPayload;
  actorId: string;
  correlationId: string;
}

export interface ProcessWebhookResult {
  wasDuplicate: boolean;
  requestStatus: VerificationStatus | null; // null if the webhook was a duplicate and no state change occurred
}

/**
 * Handles an inbound vendor webhook: delegates signature verification and
 * idempotent processing to the specific adapter (Day 2's handleCallback),
 * then — for a genuinely new, successful callback — transitions the state
 * machine VENDOR_CALLBACK_AWAITED -> VERIFICATION_IN_PROGRESS and resumes
 * the remaining workflow steps.
 *
 * Note on requestId resolution: production webhook payloads carry the
 * VENDOR's session/reference ID (e.g. SigniVision's sessionId), not our
 * internal requestId. Mapping vendor reference -> our requestId is a
 * lookup this use case deliberately does NOT perform itself — that
 * mapping belongs to whichever component owns the correlation (e.g. a
 * VendorReferenceIndex keyed by vendorReferenceId, a Day 6+ concern this
 * project's timeline doesn't reach). The webhook controller layer is
 * expected to resolve requestId before calling this use case; flagging
 * this explicitly rather than silently assuming it's solved.
 */
export class ProcessWebhookUseCase {
  constructor(
    private readonly customerRepository: CustomerRepositoryPort,
    private readonly requestRepository: VerificationRequestRepositoryPort,
    private readonly auditTrail: AuditTrailPort,
    private readonly notifications: NotificationPort,
    private readonly workflowConfigProvider: WorkflowConfigProvider,
    private readonly vendorFactory: VendorAdapterFactory,
    private readonly timerService: TimerService,
  ) {}

  async execute(command: ProcessWebhookCommand): Promise<ProcessWebhookResult> {
    const request = await this.requestRepository.findById(command.requestId);
    if (!request) throw new WebhookRequestNotFoundError(command.requestId);

    const customer = await this.customerRepository.findById(request.toProps().customerId);
    if (!customer) throw new WebhookRequestNotFoundError(command.requestId); // customer missing is equally unrecoverable here

    const adapter = this.vendorFactory.getAdapter(command.vendorType);
    const callbackResult = await adapter.handleCallback(command.payload);

    if (callbackResult.wasDuplicate) {
      return { wasDuplicate: true, requestStatus: null };
    }

    await this.timerService.cancelAllForCustomer(
      customer.customerId,
      TimerType.VENDOR_CALLBACK_TIMEOUT,
    );

    const sideEffectHandler = createStateMachineSideEffectHandler(
      this.auditTrail,
      this.notifications,
      {
        customerId: customer.customerId,
        actorId: command.actorId,
        actorType: AuditActorType.VENDOR,
        correlationId: command.correlationId,
      },
    );
    const stateMachine = new VerificationStateMachine(request.status, sideEffectHandler);

    const callbackSucceeded = callbackResult.processed && callbackResult.result?.success === true;
    if (!callbackSucceeded) {
      await stateMachine.apply(VerificationEvent.STEP_FAILED, { stepFailureNonRecoverable: true });
      await this.persistFinalState(request, stateMachine.getCurrentState(), customer);
      return { wasDuplicate: false, requestStatus: stateMachine.getCurrentState() };
    }

    await stateMachine.apply(VerificationEvent.CALLBACK_RECEIVED, { webhookSignatureValid: true });

    const config = this.workflowConfigProvider.getConfig(request.toProps().tier);
    const engine = new WorkflowEngine(new VendorStepExecutor(this.vendorFactory));
    const result = await engine.executeWorkflow(config, {
      customerId: customer.customerId,
      requestId: command.requestId,
      flags: {},
      metadata: { tier: config.tier },
    });

    let finalStatus: VerificationStatus;
    if (result.awaitingManualStep) {
      await stateMachine.apply(VerificationEvent.RISK_ELEVATED, {
        riskScoreExceedsEddThreshold: true,
      });
      finalStatus = stateMachine.getCurrentState();
    } else if (result.allStepsSucceeded) {
      await stateMachine.apply(VerificationEvent.ALL_PASSED, { allStepsPassed: true });
      finalStatus = stateMachine.getCurrentState();
    } else {
      await stateMachine.apply(VerificationEvent.STEP_FAILED, { stepFailureNonRecoverable: true });
      finalStatus = stateMachine.getCurrentState();
    }

    await this.persistFinalState(request, finalStatus, customer);
    return { wasDuplicate: false, requestStatus: finalStatus };
  }

  private async persistFinalState(
    request: VerificationRequest,
    finalStatus: VerificationStatus,
    customer: NonNullable<Awaited<ReturnType<CustomerRepositoryPort['findById']>>>,
  ): Promise<void> {
    const isTerminal =
      finalStatus === VerificationStatus.VERIFIED || finalStatus === VerificationStatus.REJECTED;
    const persistedRequest = VerificationRequest.reconstitute({
      ...request.toProps(),
      status: finalStatus,
      completedAt: isTerminal ? new Date() : request.toProps().completedAt,
    });
    await this.requestRepository.save(persistedRequest);
    customer.transitionStatus(finalStatus);
    await this.customerRepository.save(customer);
  }
}
