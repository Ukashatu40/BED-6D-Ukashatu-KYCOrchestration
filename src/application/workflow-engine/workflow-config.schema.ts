// src/application/workflow-engine/workflow-config.schema.ts
import { KycTier } from '../../domain/value-objects/kyc-tier.enum';
import { DocumentType } from '../../domain/value-objects/document-type.enum';
import { VendorType } from '../ports/kyc-vendor.port';

export type ApprovalAuthority =
  'AUTOMATED' | 'AUTOMATED_WITH_EXCEPTION_QUEUE' | 'MANDATORY_COMPLIANCE_REVIEW';

export interface RetryPolicyYaml {
  maxRetries: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  maxDelayMs: number;
}

export interface WorkflowStepYaml {
  stepName: string;
  vendorType: VendorType | null;
  order: number;
  parallelGroup: string | null;
  guardExpression: string | null;
  timeoutSeconds: number | null;
  isAsync?: boolean;
  isManualStep?: boolean;
  retryPolicy?: RetryPolicyYaml;
}

export interface RequiredDocumentYaml {
  documentType: DocumentType;
  mandatory: boolean;
}

export interface WorkflowConfigYaml {
  tier: KycTier;
  description: string;
  targetCompletionMinutes: number;
  approvalAuthority: ApprovalAuthority;
  requiredDocuments: RequiredDocumentYaml[];
  steps: WorkflowStepYaml[];
  ckycUpload: {
    timing: string;
    deadlineDays: number;
  };
  reVerification: {
    frequency: string;
  };
  documentRetentionYears: number;
  ongoingMonitoring: boolean | string;
}
