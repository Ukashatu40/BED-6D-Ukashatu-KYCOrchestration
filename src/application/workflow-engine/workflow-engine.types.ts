// src/application/workflow-engine/workflow-engine.types.ts
import { VendorVerificationResult } from '../ports/kyc-vendor.port';
import { WorkflowStepYaml } from './workflow-config.schema';

export interface WorkflowExecutionContext {
  customerId: string;
  requestId: string;
  /** Boolean flags guard expressions evaluate against — populated by prior step results (e.g. ckycRecordFound) and external inputs (e.g. complianceApproved). */
  flags: Record<string, boolean>;
  /** Accumulated vendor metadata to pass into subsequent vendor calls (name, dateOfBirth, panNumber, etc.), mirrors KycVendorPort's VerificationContext.metadata shape. */
  metadata: Record<string, unknown>;
}

export interface StepExecutionResult {
  stepName: string;
  vendorType: string | null;
  succeeded: boolean;
  skipped: boolean;
  isManualStep: boolean;
  vendorResult?: VendorVerificationResult;
  error?: string;
}

export interface WorkflowExecutionResult {
  tier: string;
  allStepsSucceeded: boolean;
  awaitingManualStep: boolean;
  stepResults: StepExecutionResult[];
}

export interface WorkflowStepExecutor {
  /** Executes a single vendor step to completion (including its own retry policy) and returns the normalised result. Manual steps never reach this — the engine short-circuits on isManualStep before calling it. */
  executeVendorStep(
    step: WorkflowStepYaml,
    context: WorkflowExecutionContext,
  ): Promise<VendorVerificationResult>;
}
