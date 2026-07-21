// src/application/workflow-engine/vendor-step.executor.ts
import { VendorAdapterFactory } from '../../infrastructure/vendors/vendor-adapter.factory';
import { KycTier } from '../../domain/value-objects/kyc-tier.enum';
import { VendorVerificationResult, VerificationContext } from '../ports/kyc-vendor.port';
import { WorkflowExecutionContext, WorkflowStepExecutor } from './workflow-engine.types';
import { WorkflowStepYaml } from './workflow-config.schema';

/**
 * Bridges the vendor-agnostic WorkflowEngine (Day 3) to the concrete
 * VendorAdapterFactory (Day 2). For synchronous vendor steps (Digilocker,
 * CKYC, AML) — call initiateVerification then immediately fetchResult,
 * matching how every adapter's contract test exercises them. For async
 * steps (video-kyc-session, the only one flagged isAsync: true in
 * edd.yml) — call initiateVerification only, and signal WorkflowEngine to
 * halt via the awaitingCallback marker; the actual completion arrives
 * later when ProcessWebhookUseCase invokes the adapter's handleCallback,
 * which is a separate execution path entirely, not this executor.
 */
export class VendorStepExecutor implements WorkflowStepExecutor {
  constructor(private readonly vendorFactory: VendorAdapterFactory) {}

  async executeVendorStep(
    step: WorkflowStepYaml,
    context: WorkflowExecutionContext,
  ): Promise<VendorVerificationResult> {
    if (!step.vendorType) {
      throw new Error(
        `executeVendorStep called for step "${step.stepName}" with no vendorType — manual steps must never reach this executor`,
      );
    }

    const adapter = this.vendorFactory.getAdapter(step.vendorType);
    const verificationContext: VerificationContext = {
      customerId: context.customerId,
      requestId: context.requestId,
      tier: (context.metadata.tier as KycTier) ?? KycTier.MINIMUM,
      metadata: context.metadata,
    };

    const initiation = await adapter.initiateVerification(verificationContext);

    if (step.isAsync && initiation.isAsync) {
      return {
        vendorReferenceId: initiation.vendorReferenceId,
        success: true,
        normalisedData: { awaitingCallback: true },
      };
    }

    return adapter.fetchResult(initiation.vendorReferenceId);
  }
}
