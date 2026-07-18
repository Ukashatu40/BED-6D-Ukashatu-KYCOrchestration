import { randomUUID } from 'crypto';
import {
  CallbackProcessingResult,
  InternalErrorCategory,
  KycVendorPort,
  VendorHealthStatus,
  VendorInitiationResult,
  VendorStatusResult,
  VendorType,
  VendorVerificationResult,
  VerificationContext,
  WebhookPayload,
} from '../../../application/ports/kyc-vendor.port';
import { VendorNormalisedError } from '../../../application/ports/internal-error';
import { CircuitBreaker } from '../circuit-breaker';
import {
  CKYC_SEARCH_DOWNLOAD_RETRY,
  CKYC_UPLOAD_RETRY,
  RetryPolicy,
  retryWithBackoff,
} from '../retry.util';
import { mapCkycError } from './ckyc-error-map';
import { CkycSoapClient } from './ckyc-soap-client.interface';
import { CkycUploadRecord } from './ckyc.types';

const KIN_PATTERN = /^\d{14}$/;

export interface CkycAdapterConfig {
  certificateExpiryDate: Date;
}

interface CkycOperation {
  kind: 'SEARCH_THEN_DOWNLOAD' | 'UPLOAD';
  panOrCustomerId: string;
  context: VerificationContext;
}

/**
 * KycVendorPort implementation for the Central KYC Registry (CERSAI).
 * SOAP/XML over mutual TLS — the architecturally hardest adapter per spec
 * Section A2.2, because it bridges a REST-native system with legacy
 * government infrastructure (ADR-001's justification for the port-adapter
 * pattern in the first place).
 *
 * Flow this adapter models: initiateVerification triggers a Search; if a
 * record exists, fetchResult performs a Download (using an existing record —
 * no upload needed). If no record exists, fetchResult performs an Upload of
 * freshly-collected KYC data instead. Both outcomes are legitimate "success"
 * states per Section A1.1's CKYC interoperability requirement (search first,
 * avoid duplicate KYC).
 */
export class CkycAdapter implements KycVendorPort {
  private readonly operations = new Map<string, CkycOperation>();

  constructor(
    private readonly soapClient: CkycSoapClient,
    private readonly config: CkycAdapterConfig,
    private readonly circuitBreaker: CircuitBreaker,
    private readonly searchDownloadRetryPolicy: RetryPolicy = CKYC_SEARCH_DOWNLOAD_RETRY,
    private readonly uploadRetryPolicy: RetryPolicy = CKYC_UPLOAD_RETRY,
  ) {}

  async initiateVerification(context: VerificationContext): Promise<VendorInitiationResult> {
    this.assertCertificateNotExpired();
    const panOrCustomerId = this.extractPan(context);
    const referenceId = `ckyc-${randomUUID()}`;
    this.operations.set(referenceId, {
      kind: 'SEARCH_THEN_DOWNLOAD',
      panOrCustomerId,
      context,
    });
    return {
      vendorReferenceId: referenceId,
      isAsync: false,
      estimatedCompletionSeconds: 5,
    };
  }

  async checkStatus(referenceId: string): Promise<VendorStatusResult> {
    // CKYC is synchronous end-to-end (no async callback model) — status is
    // always resolved by the time fetchResult can be called. This method
    // exists to satisfy the port contract for orchestration engines that
    // poll uniformly across vendors.
    const op = this.requireOperation(referenceId);
    return {
      vendorReferenceId: referenceId,
      status: 'IN_PROGRESS',
      rawVendorStatus: op.kind,
    };
  }

  async fetchResult(referenceId: string): Promise<VendorVerificationResult> {
    this.assertCertificateNotExpired();
    const op = this.requireOperation(referenceId);

    return this.circuitBreaker.execute(async () => {
      return retryWithBackoff(
        async () => {
          try {
            const searchResult = await this.soapClient.search(op.panOrCustomerId);

            if (searchResult.found && searchResult.kin) {
              const record = await this.soapClient.download(searchResult.kin);
              return {
                vendorReferenceId: referenceId,
                success: true,
                normalisedData: {
                  source: 'CKYC_EXISTING_RECORD',
                  kin: record.kin,
                  name: record.name,
                  dateOfBirth: record.dateOfBirth,
                  address: record.address,
                  documentCount: record.documents.length,
                },
              };
            }

            // No existing record — upload fresh KYC data collected upstream
            // (Digilocker step etc.) via context.metadata.
            const uploadRecord = this.buildUploadRecord(op);
            const uploadResult = await this.soapClient.upload(uploadRecord);

            if (!uploadResult.success || !uploadResult.kin) {
              throw {
                code: uploadResult.errorCode ?? 'unknown-upload-failure',
                message: 'CKYC upload did not return a KIN',
              };
            }
            if (!KIN_PATTERN.test(uploadResult.kin)) {
              throw new VendorNormalisedError(
                InternalErrorCategory.VENDOR_ERROR,
                false,
                'malformed-kin',
                VendorType.CKYC,
                `CKYC returned a malformed KIN: ${uploadResult.kin}`,
              );
            }

            return {
              vendorReferenceId: referenceId,
              success: true,
              normalisedData: {
                source: 'CKYC_FRESH_UPLOAD',
                kin: uploadResult.kin,
              },
            };
          } catch (err) {
            throw this.normaliseError(err);
          }
        },
        this.searchDownloadRetryPolicy,
        (err) => this.isRetryable(err),
      );
    });
  }

  /**
   * Batch upload path (up to 1000 records per batch per Section A2.2) — not
   * part of KycVendorPort's single-customer contract, exposed separately for
   * the nightly bulk-onboarding job. Individual record-level success/failure
   * is preserved rather than failing the whole batch on one bad record.
   */
  async uploadBatch(records: CkycUploadRecord[]): Promise<{
    batchId: string;
    succeeded: string[];
    failed: Array<{ customerId: string; errorCode: string }>;
  }> {
    if (records.length === 0 || records.length > 1000) {
      throw new VendorNormalisedError(
        InternalErrorCategory.VALIDATION_ERROR,
        false,
        'invalid-batch-size',
        VendorType.CKYC,
        `Batch size must be 1-1000, got ${records.length}`,
      );
    }
    return this.circuitBreaker.execute(async () => {
      return retryWithBackoff(
        async () => {
          try {
            const result = await this.soapClient.uploadBatch(records);
            const succeeded = result.results.filter((r) => r.success).map((r) => r.customerId);
            const failed = result.results
              .filter((r) => !r.success)
              .map((r) => ({ customerId: r.customerId, errorCode: r.errorCode ?? 'unknown' }));
            return { batchId: result.batchId, succeeded, failed };
          } catch (err) {
            throw this.normaliseError(err);
          }
        },
        this.uploadRetryPolicy,
        (err) => this.isRetryable(err),
      );
    });
  }

  /** CKYC has no webhook model (pure SOAP request/response) — never called in practice. */
  async handleCallback(_payload: WebhookPayload): Promise<CallbackProcessingResult> {
    return { processed: false, wasDuplicate: false };
  }

  async getHealthStatus(): Promise<VendorHealthStatus> {
    return {
      vendorType: VendorType.CKYC,
      isHealthy: this.circuitBreaker.getState() === 'CLOSED' && !this.isCertificateExpired(),
      circuitBreakerState: this.circuitBreaker.getState(),
    };
  }

  private buildUploadRecord(op: CkycOperation): CkycUploadRecord {
    const metadata = op.context.metadata;
    return {
      customerId: op.context.customerId,
      name: String(metadata.name ?? ''),
      dateOfBirth: String(metadata.dateOfBirth ?? ''),
      address: String(metadata.address ?? ''),
      panNumber: op.panOrCustomerId,
      documents: Array.isArray(metadata.documents)
        ? (metadata.documents as CkycUploadRecord['documents'])
        : [],
    };
  }

  private extractPan(context: VerificationContext): string {
    const pan = context.metadata.panNumber;
    if (typeof pan !== 'string' || pan.trim().length === 0) {
      throw new VendorNormalisedError(
        InternalErrorCategory.VALIDATION_ERROR,
        false,
        'missing-pan',
        VendorType.CKYC,
        'VerificationContext.metadata.panNumber is required for CKYC search',
      );
    }
    return pan;
  }

  private requireOperation(referenceId: string): CkycOperation {
    const op = this.operations.get(referenceId);
    if (!op) {
      throw new VendorNormalisedError(
        InternalErrorCategory.NOT_FOUND,
        false,
        'operation-not-found',
        VendorType.CKYC,
        `No CKYC operation found for reference ${referenceId}`,
      );
    }
    return op;
  }

  private isCertificateExpired(): boolean {
    return this.config.certificateExpiryDate <= new Date();
  }

  private assertCertificateNotExpired(): void {
    if (this.isCertificateExpired()) {
      throw new VendorNormalisedError(
        InternalErrorCategory.AUTHENTICATION_ERROR,
        false,
        'certificate-expired',
        VendorType.CKYC,
        'CERSAI mutual TLS client certificate has expired — renewal required (see runbook)',
      );
    }
  }

  private isRetryable(err: unknown): boolean {
    if (err instanceof VendorNormalisedError) {
      return err.retryable;
    }
    return false;
  }

  private normaliseError(err: unknown): VendorNormalisedError {
    if (err instanceof VendorNormalisedError) {
      return err;
    }
    const vendorCode = this.extractVendorCode(err);
    const mapping = mapCkycError(vendorCode);
    return new VendorNormalisedError(
      mapping.category,
      mapping.retryable,
      vendorCode,
      VendorType.CKYC,
      `CKYC error [${vendorCode}]: ${mapping.action}`,
    );
  }

  private extractVendorCode(err: unknown): string {
    if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
      return err.code;
    }
    return 'unknown-error';
  }
}
