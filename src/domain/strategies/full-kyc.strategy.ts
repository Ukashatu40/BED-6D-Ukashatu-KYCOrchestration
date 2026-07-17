// src/domain/strategies/full-kyc.strategy.ts
import { KycTier } from '../value-objects/kyc-tier.enum';
import { DocumentType } from '../value-objects/document-type.enum';
import { VendorType } from '../../application/ports/kyc-vendor.port';
import {
  ApprovalLevel,
  DocumentRequirement,
  RetryConfiguration,
  VerificationStrategy,
  WorkflowStep,
} from './verification-strategy.interface';

/** Stub — full step sequence loaded from config/workflows/full-kyc.yml in Day 3. */
export class FullKycStrategy implements VerificationStrategy {
  readonly tier = KycTier.FULL;

  getRequiredDocuments(): DocumentRequirement[] {
    return [
      { documentType: DocumentType.PAN, mandatory: true },
      { documentType: DocumentType.AADHAAR, mandatory: true },
      { documentType: DocumentType.ADDRESS_PROOF, mandatory: true },
    ];
  }

  getVerificationSteps(): WorkflowStep[] {
    return [
      { stepName: 'ckyc-search', vendorType: VendorType.CKYC, order: 1 },
      {
        stepName: 'digilocker-fetch',
        vendorType: VendorType.DIGILOCKER,
        order: 2,
        parallelGroup: 'docs',
      },
      {
        stepName: 'full-aml-screen',
        vendorType: VendorType.AML_SCREENING,
        order: 3,
      },
      {
        stepName: 'ckyc-upload',
        vendorType: VendorType.CKYC,
        order: 4,
        guardExpression: 'isFreshKyc',
      },
    ];
  }

  getApprovalAuthority(): ApprovalLevel {
    return 'AUTOMATED_WITH_EXCEPTION_QUEUE';
  }

  getCompletionTargetMinutes(): number {
    return 30;
  }

  getRetryPolicy(): RetryConfiguration {
    return {
      maxRetries: 2,
      initialDelayMs: 2000,
      backoffMultiplier: 2,
      maxDelayMs: 10000,
    };
  }
}
