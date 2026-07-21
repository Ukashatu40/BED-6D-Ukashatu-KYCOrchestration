// src/application/use-cases/initiate-kyc.use-case.ts
import { randomUUID } from 'crypto';
import { KycTier } from '../../domain/value-objects/kyc-tier.enum';
import { VerificationStatus } from '../../domain/value-objects/verification-status.enum';
import { AuditActorType } from '../../domain/entities/audit-event.entity';
import { VerificationRequest } from '../../domain/entities/verification-request.entity';
import { TierSelector, TierSelectionContext } from '../../domain/strategies/tier-selector';
import {
  VerificationEvent,
  VerificationStateMachine,
} from '../../domain/state-machine/verification-state-machine';
import { WorkflowConfigYaml } from '../workflow-engine/workflow-config.schema';
import { createStateMachineSideEffectHandler } from '../workflow-engine/state-machine-side-effects';
import { CustomerRepositoryPort } from '../ports/customer-repository.port';
import { VerificationRequestRepositoryPort } from '../ports/verification-request-repository.port';
import { AuditTrailPort } from '../ports/audit-trail.port';
import { NotificationPort } from '../ports/notification.port';

export class CustomerNotFoundError extends Error {
  constructor(customerId: string) {
    super(`No customer found with ID ${customerId}`);
    this.name = 'CustomerNotFoundError';
  }
}

export interface InitiateKycCommand {
  customerId: string;
  loanAmountInr: number;
  isPep: boolean;
  isHighRiskJurisdiction: boolean;
  actorId: string;
  actorType: AuditActorType;
  correlationId: string;
}

export interface InitiateKycResult {
  requestId: string;
  tier: KycTier;
  status: VerificationStatus;
}

/** Provides the loaded WorkflowConfigYaml for a tier — injected so tests don't touch the filesystem; production wiring points this at loadWorkflowConfig against config/workflows/*.yml, cached at bootstrap. */
export interface WorkflowConfigProvider {
  getConfig(tier: KycTier): WorkflowConfigYaml;
}

/**
 * Determines the customer's KYC tier, creates a VerificationRequest,
 * drives it through NOT_STARTED -> INITIATED -> DOCUMENTS_PENDING via the
 * state machine, and persists both the request and the customer's mirrored
 * status. Deliberately stops at DOCUMENTS_PENDING — the customer must
 * still upload documents (a separate API call/use case) before
 * VERIFY_START can fire and the actual vendor workflow begins.
 */
export class InitiateKycUseCase {
  constructor(
    private readonly customerRepository: CustomerRepositoryPort,
    private readonly requestRepository: VerificationRequestRepositoryPort,
    private readonly auditTrail: AuditTrailPort,
    private readonly notifications: NotificationPort,
    private readonly workflowConfigProvider: WorkflowConfigProvider,
    private readonly tierSelector: TierSelector = new TierSelector(),
  ) {}

  async execute(command: InitiateKycCommand): Promise<InitiateKycResult> {
    const customer = await this.customerRepository.findById(command.customerId);
    if (!customer) {
      throw new CustomerNotFoundError(command.customerId);
    }

    const tierContext: TierSelectionContext = {
      loanAmountInr: command.loanAmountInr,
      isPep: command.isPep,
      isHighRiskJurisdiction: command.isHighRiskJurisdiction,
    };
    const tier = this.tierSelector.selectTier(tierContext);
    const config = this.workflowConfigProvider.getConfig(tier);

    const requestId = randomUUID();
    const expiresAt = new Date(Date.now() + config.targetCompletionMinutes * 60 * 1000);
    const request = VerificationRequest.create({
      requestId,
      customerId: command.customerId,
      tier,
      workflowConfigVersion: '1.0.0',
      initiatedBy: command.actorId,
      expiresAt,
      retryOf: null,
    });

    const sideEffectHandler = createStateMachineSideEffectHandler(
      this.auditTrail,
      this.notifications,
      {
        customerId: command.customerId,
        actorId: command.actorId,
        actorType: command.actorType,
        correlationId: command.correlationId,
      },
    );
    const stateMachine = new VerificationStateMachine(
      VerificationStatus.NOT_STARTED,
      sideEffectHandler,
    );

    await stateMachine.apply(VerificationEvent.KYC_INITIATED, {
      validCustomerAndTierAssigned: true,
    });

    const hasDocumentSteps = config.requiredDocuments.length > 0;
    await stateMachine.apply(VerificationEvent.DOCS_REQUESTED, {
      workflowHasDocumentSteps: hasDocumentSteps,
    });

    const finalStatus = stateMachine.getCurrentState();

    // VerificationRequest (Day 1) doesn't expose a public status setter
    // beyond markCompleted — reconstitute with the state machine's result
    // rather than adding a setter that would let anything else bypass the
    // state machine, which is exactly the anti-pattern the spec warns
    // against (p.37-38, "String-Based State Management").
    const persistedRequest = VerificationRequest.reconstitute({
      ...request.toProps(),
      status: finalStatus,
      currentStep: 'awaiting-documents',
    });
    await this.requestRepository.save(persistedRequest);

    const tierOrder = [KycTier.MINIMUM, KycTier.FULL, KycTier.EDD];
    if (tierOrder.indexOf(tier) > tierOrder.indexOf(customer.kycTier)) {
      customer.upgradeTier(tier);
    }
    customer.transitionStatus(finalStatus);
    await this.customerRepository.save(customer);

    return { requestId, tier, status: finalStatus };
  }

  /** Customer.upgradeTier throws on a same-or-backward move; a brand-new customer at MINIMUM (the Customer entity's typical initial state) upgrading to MINIMUM again would hit that guard. This keeps the call a no-op in that specific case without weakening the entity's own invariant. */
}
