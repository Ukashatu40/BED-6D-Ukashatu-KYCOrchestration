// src/domain/strategies/minimum-kyc.strategy.ts
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

/** Stub — full step sequence loaded from config/workflows/minimum-kyc.yml in Day 3. */
export class MinimumKycStrategy implements VerificationStrategy {
  readonly tier = KycTier.MINIMUM;

  getRequiredDocuments(): DocumentRequirement[] {
    return [{ documentType: DocumentType.AADHAAR, mandatory: true }];
  }

  getVerificationSteps(): WorkflowStep[] {
    return [
      {
        stepName: 'aadhaar-otp-fetch',
        vendorType: VendorType.DIGILOCKER,
        order: 1,
      },
      {
        stepName: 'basic-name-screen',
        vendorType: VendorType.AML_SCREENING,
        order: 2,
      },
    ];
  }

  getApprovalAuthority(): ApprovalLevel {
    return 'AUTOMATED';
  }

  getCompletionTargetMinutes(): number {
    return 5;
  }

  getRetryPolicy(): RetryConfiguration {
    return {
      maxRetries: 3,
      initialDelayMs: 1000,
      backoffMultiplier: 2,
      maxDelayMs: 8000,
    };
  }
}
