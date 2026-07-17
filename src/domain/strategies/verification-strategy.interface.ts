// src/domain/strategies/verification-strategy.interface.ts
import { KycTier } from '../value-objects/kyc-tier.enum';
import { DocumentType } from '../value-objects/document-type.enum';
import { VendorType } from '../../application/ports/kyc-vendor.port';

export type ApprovalLevel =
  | 'AUTOMATED'
  | 'AUTOMATED_WITH_EXCEPTION_QUEUE'
  | 'MANDATORY_COMPLIANCE_REVIEW';

export interface DocumentRequirement {
  documentType: DocumentType;
  mandatory: boolean;
}

export interface WorkflowStep {
  stepName: string;
  vendorType: VendorType;
  order: number;
  parallelGroup?: string;
  guardExpression?: string;
}

export interface RetryConfiguration {
  maxRetries: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
}

/**
 * Strategy Pattern for tier selection (Section A3.3). Adding a fourth tier
 * requires only a new class implementing this interface + a YAML config
 * entry — no changes to WorkflowEngine.
 */
export interface VerificationStrategy {
  readonly tier: KycTier;
  getRequiredDocuments(): DocumentRequirement[];
  getVerificationSteps(): WorkflowStep[];
  getApprovalAuthority(): ApprovalLevel;
  getCompletionTargetMinutes(): number;
  getRetryPolicy(): RetryConfiguration;
}
