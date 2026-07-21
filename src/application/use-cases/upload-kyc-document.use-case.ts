// src/application/use-cases/upload-kyc-document.use-case.ts
import { AuditActorType } from '../../domain/entities/audit-event.entity';
import { DocumentType } from '../../domain/value-objects/document-type.enum';
import { VerificationStatus } from '../../domain/value-objects/verification-status.enum';
import { VerificationRequest } from '../../domain/entities/verification-request.entity';
import {
  VerificationEvent,
  VerificationStateMachine,
} from '../../domain/state-machine/verification-state-machine';
import { WorkflowConfigYaml } from '../workflow-engine/workflow-config.schema';
import { WorkflowEngine } from '../workflow-engine/workflow-engine';
import { WorkflowExecutionResult } from '../workflow-engine/workflow-engine.types';
import { VendorStepExecutor } from '../workflow-engine/vendor-step.executor';
import { createStateMachineSideEffectHandler } from '../workflow-engine/state-machine-side-effects';
import { TimerService } from '../workflow-engine/timer.service';
import { TimerType } from '../ports/timer-repository.port';
import { CustomerRepositoryPort } from '../ports/customer-repository.port';
import { VerificationRequestRepositoryPort } from '../ports/verification-request-repository.port';
import { DocumentRepositoryPort } from '../ports/document-repository.port';
import { AuditTrailPort } from '../ports/audit-trail.port';
import { NotificationPort } from '../ports/notification.port';
import {
  DocumentStorageService,
  ActorContext,
} from '../../infrastructure/storage/document-storage.service';
import { VendorAdapterFactory } from '../../infrastructure/vendors/vendor-adapter.factory';
import { WorkflowConfigProvider } from './initiate-kyc.use-case';

export class VerificationRequestNotFoundError extends Error {
  constructor(requestId: string) {
    super(`No verification request found with ID ${requestId}`);
    this.name = 'VerificationRequestNotFoundError';
  }
}

export class UploadDocumentCustomerNotFoundError extends Error {
  constructor(customerId: string) {
    super(`No customer found with ID ${customerId}`);
    this.name = 'UploadDocumentCustomerNotFoundError';
  }
}

export interface UploadKycDocumentCommand {
  requestId: string;
  customerId: string;
  documentType: DocumentType;
  fileBytes: Buffer;
  actorId: string;
  actorType: AuditActorType;
  correlationId: string;
}

export interface UploadKycDocumentResult {
  documentId: string;
  requestStatus: VerificationStatus;
  allRequiredDocumentsPresent: boolean;
}

export class UploadKycDocumentUseCase {
  constructor(
    private readonly customerRepository: CustomerRepositoryPort,
    private readonly requestRepository: VerificationRequestRepositoryPort,
    private readonly documentRepository: DocumentRepositoryPort,
    private readonly documentStorageService: DocumentStorageService,
    private readonly auditTrail: AuditTrailPort,
    private readonly notifications: NotificationPort,
    private readonly workflowConfigProvider: WorkflowConfigProvider,
    private readonly vendorFactory: VendorAdapterFactory,
    private readonly timerService: TimerService,
  ) {}

  async execute(command: UploadKycDocumentCommand): Promise<UploadKycDocumentResult> {
    const request = await this.requestRepository.findById(command.requestId);
    if (!request) throw new VerificationRequestNotFoundError(command.requestId);

    const customer = await this.customerRepository.findById(command.customerId);
    if (!customer) throw new UploadDocumentCustomerNotFoundError(command.customerId);

    const actor: ActorContext = {
      actorType: command.actorType,
      actorId: command.actorId,
      correlationId: command.correlationId,
    };
    const document = await this.documentStorageService.uploadDocument(
      command.customerId,
      command.documentType,
      command.fileBytes,
      actor,
    );

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
    const stateMachine = new VerificationStateMachine(request.status, sideEffectHandler);
    await stateMachine.apply(VerificationEvent.DOC_UPLOADED, { documentValidNotExpired: true });

    const config = this.workflowConfigProvider.getConfig(request.toProps().tier);
    const activeDocuments = await this.documentRepository.findActiveByCustomer(command.customerId);
    const uploadedTypes = new Set(activeDocuments.map((d) => d.documentType));
    const mandatoryTypes = config.requiredDocuments
      .filter((d) => d.mandatory)
      .map((d) => d.documentType);
    const allRequiredDocumentsPresent = mandatoryTypes.every((t) => uploadedTypes.has(t));

    let finalStatus = stateMachine.getCurrentState();
    if (allRequiredDocumentsPresent) {
      finalStatus = await this.runVendorWorkflow(stateMachine, config, command, request.requestId);
    }

    await this.persistFinalState(request, finalStatus, customer);

    return {
      documentId: document.documentId,
      requestStatus: finalStatus,
      allRequiredDocumentsPresent,
    };
  }

  private async runVendorWorkflow(
    stateMachine: VerificationStateMachine,
    config: WorkflowConfigYaml,
    command: UploadKycDocumentCommand,
    requestId: string,
  ): Promise<VerificationStatus> {
    await stateMachine.apply(VerificationEvent.VERIFY_START, { allRequiredDocumentsPresent: true });

    const engine = new WorkflowEngine(new VendorStepExecutor(this.vendorFactory));
    const result: WorkflowExecutionResult = await engine.executeWorkflow(config, {
      customerId: command.customerId,
      requestId,
      flags: {},
      metadata: { tier: config.tier },
    });

    if (result.awaitingCallback) {
      await stateMachine.apply(VerificationEvent.VENDOR_ASYNC, { isAsyncVendorStep: true });
      await this.timerService.scheduleFixedTimer({
        timerType: TimerType.VENDOR_CALLBACK_TIMEOUT,
        customerId: command.customerId,
        requestId,
      });
      return stateMachine.getCurrentState();
    }

    if (result.awaitingManualStep) {
      // Bridged onto risk.elevated — see class-level interpretation note.
      await stateMachine.apply(VerificationEvent.RISK_ELEVATED, {
        riskScoreExceedsEddThreshold: true,
      });
      return stateMachine.getCurrentState();
    }

    if (result.allStepsSucceeded) {
      await stateMachine.apply(VerificationEvent.ALL_PASSED, { allStepsPassed: true });
      return stateMachine.getCurrentState();
    }

    await stateMachine.apply(VerificationEvent.STEP_FAILED, { stepFailureNonRecoverable: true });
    return stateMachine.getCurrentState();
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
