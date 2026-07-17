// src/domain/strategies/edd.strategy.ts
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

/** Stub — full step sequence loaded from config/workflows/edd.yml in Day 3. */
export class EddStrategy implements VerificationStrategy {
  readonly tier = KycTier.EDD;

  getRequiredDocuments(): DocumentRequirement[] {
    return [
      { documentType: DocumentType.PAN, mandatory: true },
      { documentType: DocumentType.AADHAAR, mandatory: true },
      { documentType: DocumentType.ADDRESS_PROOF, mandatory: true },
      { documentType: DocumentType.INCOME_PROOF, mandatory: true },
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
        stepName: 'video-kyc-session',
        vendorType: VendorType.VIDEO_KYC,
        order: 3,
      },
      {
        stepName: 'full-aml-screen-adverse-media',
        vendorType: VendorType.AML_SCREENING,
        order: 4,
      },
      {
        stepName: 'ongoing-monitoring-register',
        vendorType: VendorType.AML_SCREENING,
        order: 5,
      },
      { stepName: 'ckyc-upload', vendorType: VendorType.CKYC, order: 6 },
    ];
  }

  getApprovalAuthority(): ApprovalLevel {
    return 'MANDATORY_COMPLIANCE_REVIEW';
  }

  getCompletionTargetMinutes(): number {
    return 48 * 60;
  }

  getRetryPolicy(): RetryConfiguration {
    return {
      maxRetries: 2,
      initialDelayMs: 1000,
      backoffMultiplier: 2,
      maxDelayMs: 5000,
    };
  }
}
