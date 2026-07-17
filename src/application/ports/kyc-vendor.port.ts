// src/application/ports/kyc-vendor.port.ts
import { KycTier } from '../../domain/value-objects/kyc-tier.enum';
import { DocumentType } from '../../domain/value-objects/document-type.enum';

export enum VendorType {
  DIGILOCKER = 'DIGILOCKER',
  CKYC = 'CKYC',
  VIDEO_KYC = 'VIDEO_KYC',
  AML_SCREENING = 'AML_SCREENING',
}

export enum InternalErrorCategory {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  AUTHENTICATION_ERROR = 'AUTHENTICATION_ERROR',
  AUTHORISATION_ERROR = 'AUTHORISATION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  RATE_LIMITED = 'RATE_LIMITED',
  VENDOR_ERROR = 'VENDOR_ERROR',
  VENDOR_UNAVAILABLE = 'VENDOR_UNAVAILABLE',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

export interface VerificationContext {
  customerId: string;
  requestId: string;
  tier: KycTier;
  documentType?: DocumentType;
  metadata: Record<string, unknown>;
}

export interface VendorInitiationResult {
  vendorReferenceId: string;
  isAsync: boolean;
  estimatedCompletionSeconds?: number;
}

export interface VendorStatusResult {
  vendorReferenceId: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  rawVendorStatus: string;
}

export interface VendorVerificationResult {
  vendorReferenceId: string;
  success: boolean;
  normalisedData: Record<string, unknown>;
  errorCategory?: InternalErrorCategory;
  vendorErrorCode?: string;
}

export interface WebhookPayload {
  vendorType: VendorType;
  eventId: string;
  eventType: string;
  signature: string;
  rawBody: Buffer;
  headers: Record<string, string>;
}

export interface CallbackProcessingResult {
  processed: boolean;
  wasDuplicate: boolean;
  requestId?: string;
  result?: VendorVerificationResult;
}

export interface VendorHealthStatus {
  vendorType: VendorType;
  isHealthy: boolean;
  circuitBreakerState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  latencyMs?: number;
}

/**
 * The single port every vendor adapter must implement. The orchestration
 * engine depends only on this interface — never on a concrete adapter.
 * See ADR-001 and ADR-005.
 */
export interface KycVendorPort {
  initiateVerification(
    context: VerificationContext,
  ): Promise<VendorInitiationResult>;
  checkStatus(referenceId: string): Promise<VendorStatusResult>;
  fetchResult(referenceId: string): Promise<VendorVerificationResult>;
  handleCallback(payload: WebhookPayload): Promise<CallbackProcessingResult>;
  getHealthStatus(): Promise<VendorHealthStatus>;
}
