// src/infrastructure/vendors/aml-screening/aml-screening.adapter.ts
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
import { WebhookDeduplicationPort } from '../../../application/ports/webhook-deduplication.port';
import { CircuitBreaker } from '../circuit-breaker';
import { AML_REALTIME_SCREENING_RETRY, RetryPolicy, retryWithBackoff } from '../retry.util';
import { verifyHmacSignature } from '../webhook-verification.util';
import { mapGlobalWatchError } from './aml-screening-error-map';
import { signAmlRequest } from './aml-request-signer';
import { AmlScreeningHttpClient } from './aml-screening-http-client.interface';
import {
  AmlBatchScreeningRequest,
  AmlMonitoringWebhookPayload,
  AmlScreeningResponse,
} from './aml-screening.types';

const WEBHOOK_DEDUP_TTL_SECONDS = 72 * 60 * 60;
const MIN_FUZZY_THRESHOLD = 70;
const MAX_FUZZY_THRESHOLD = 100;

export interface AmlScreeningAdapterConfig {
  apiKey: string;
  requestSigningSecret: string;
  webhookHmacSecret: string;
  fuzzyMatchThreshold: number; // 70-100
}

/**
 * KycVendorPort implementation for GlobalWatch (AML/sanctions screening).
 * Real-time screening is synchronous; ongoing monitoring is a separate
 * registration step whose alerts arrive via webhook. Per Section A2.4,
 * transliteration/alias handling and threshold tuning are the vendor's
 * responsibility once we send fuzzyMatchThreshold — this adapter's job is
 * request signing, response normalisation, and error mapping, not scoring.
 */
export class AmlScreeningAdapter implements KycVendorPort {
  private readonly screenings = new Map<string, AmlScreeningResponse>();

  constructor(
    private readonly httpClient: AmlScreeningHttpClient,
    private readonly config: AmlScreeningAdapterConfig,
    private readonly circuitBreaker: CircuitBreaker,
    private readonly dedup: WebhookDeduplicationPort,
    private readonly retryPolicy: RetryPolicy = AML_REALTIME_SCREENING_RETRY,
  ) {
    if (
      config.fuzzyMatchThreshold < MIN_FUZZY_THRESHOLD ||
      config.fuzzyMatchThreshold > MAX_FUZZY_THRESHOLD
    ) {
      throw new Error(
        `AML fuzzyMatchThreshold must be between ${MIN_FUZZY_THRESHOLD} and ${MAX_FUZZY_THRESHOLD}, got ${config.fuzzyMatchThreshold}`,
      );
    }
  }

  async initiateVerification(context: VerificationContext): Promise<VendorInitiationResult> {
    const fullName = this.extractRequiredString(context, 'fullName');
    const dateOfBirth = this.extractRequiredString(context, 'dateOfBirth');
    const screeningType = (context.metadata.screeningType as string) ?? 'COMBINED';

    return this.circuitBreaker.execute(async () => {
      return retryWithBackoff(
        async () => {
          try {
            const request = {
              customerId: context.customerId,
              fullName,
              dateOfBirth,
              nationality: context.metadata.nationality as string | undefined,
              screeningType: screeningType as 'SANCTIONS' | 'PEP' | 'ADVERSE_MEDIA' | 'COMBINED',
              fuzzyMatchThreshold: this.config.fuzzyMatchThreshold,
            };
            const signature = signAmlRequest(
              JSON.stringify(request),
              this.config.apiKey,
              this.config.requestSigningSecret,
            );
            const response = await this.httpClient.screenRealTime(request, signature);
            const referenceId = response.vendorScreeningId || `aml-${randomUUID()}`;
            this.screenings.set(referenceId, response);
            return {
              vendorReferenceId: referenceId,
              isAsync: false,
              estimatedCompletionSeconds: 3,
            };
          } catch (err) {
            throw this.normaliseError(err);
          }
        },
        this.retryPolicy,
        (err) => this.isRetryable(err),
      );
    });
  }

  async checkStatus(referenceId: string): Promise<VendorStatusResult> {
    const screening = this.requireScreening(referenceId);
    return {
      vendorReferenceId: referenceId,
      status: 'COMPLETED', // real-time screening resolves synchronously in initiateVerification
      rawVendorStatus: `${screening.matchCount}-matches`,
    };
  }

  async fetchResult(referenceId: string): Promise<VendorVerificationResult> {
    const screening = this.requireScreening(referenceId);
    return {
      vendorReferenceId: referenceId,
      success: true, // "success" here means screening completed, not that the customer is clear
      normalisedData: {
        matchCount: screening.matchCount,
        matches: screening.matches,
        highestRiskScore: screening.highestRiskScore,
        highestConfidence: screening.highestConfidence,
        requiresDisposition: screening.matchCount > 0,
      },
    };
  }

  /**
   * Batch screening path (up to 5000 entities per Section A2.4) — exposed
   * separately from KycVendorPort's single-customer contract, used by the
   * nightly bulk re-screening job and the sanctions-cascade scenario (B4.2).
   */
  async screenBatch(entities: AmlBatchScreeningRequest['entities']): Promise<{
    batchId: string;
    results: Array<{ customerId: string; response: AmlScreeningResponse }>;
  }> {
    if (entities.length === 0 || entities.length > 5000) {
      throw new VendorNormalisedError(
        InternalErrorCategory.VALIDATION_ERROR,
        false,
        'invalid-batch-size',
        VendorType.AML_SCREENING,
        `Batch size must be 1-5000, got ${entities.length}`,
      );
    }
    const request: AmlBatchScreeningRequest = { entities };
    return this.circuitBreaker.execute(async () => {
      try {
        const signature = signAmlRequest(
          JSON.stringify(request),
          this.config.apiKey,
          this.config.requestSigningSecret,
        );
        return await this.httpClient.screenBatch(request, signature);
      } catch (err) {
        throw this.normaliseError(err);
      }
    });
  }

  async registerOngoingMonitoring(customerId: string): Promise<{ monitoringWebhookId: string }> {
    return this.circuitBreaker.execute(async () => {
      try {
        return await this.httpClient.registerOngoingMonitoring(customerId);
      } catch (err) {
        throw this.normaliseError(err);
      }
    });
  }

  /**
   * Handles inbound monitoring.new_match / monitoring.list_updated webhooks
   * for customers under ongoing AML monitoring. HMAC-verified and
   * idempotent, same pattern as VideoKycAdapter.
   */
  async handleCallback(payload: WebhookPayload): Promise<CallbackProcessingResult> {
    const signatureValid = verifyHmacSignature(
      payload.rawBody,
      payload.signature,
      this.config.webhookHmacSecret,
    );
    if (!signatureValid) {
      throw new VendorNormalisedError(
        InternalErrorCategory.AUTHENTICATION_ERROR,
        false,
        'invalid-webhook-signature',
        VendorType.AML_SCREENING,
        'GlobalWatch webhook HMAC signature verification failed',
      );
    }

    const alreadyProcessed = await this.dedup.hasBeenProcessed(payload.eventId);
    if (alreadyProcessed) {
      return { processed: true, wasDuplicate: true };
    }

    const body: AmlMonitoringWebhookPayload = JSON.parse(payload.rawBody.toString('utf-8'));

    await this.dedup.markProcessed(payload.eventId, WEBHOOK_DEDUP_TTL_SECONDS);

    return {
      processed: true,
      wasDuplicate: false,
      result:
        body.event === 'monitoring.new_match' && body.match
          ? {
              vendorReferenceId: body.customerId,
              success: true,
              normalisedData: {
                newMatch: body.match,
                requiresDisposition: true,
              },
            }
          : undefined,
    };
  }

  async getHealthStatus(): Promise<VendorHealthStatus> {
    return {
      vendorType: VendorType.AML_SCREENING,
      isHealthy: this.circuitBreaker.getState() === 'CLOSED',
      circuitBreakerState: this.circuitBreaker.getState(),
    };
  }

  private extractRequiredString(context: VerificationContext, field: string): string {
    const value = context.metadata[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new VendorNormalisedError(
        InternalErrorCategory.VALIDATION_ERROR,
        false,
        `missing-${field}`,
        VendorType.AML_SCREENING,
        `VerificationContext.metadata.${field} is required for AML screening`,
      );
    }
    return value;
  }

  private requireScreening(referenceId: string): AmlScreeningResponse {
    const screening = this.screenings.get(referenceId);
    if (!screening) {
      throw new VendorNormalisedError(
        InternalErrorCategory.NOT_FOUND,
        false,
        'screening-not-found',
        VendorType.AML_SCREENING,
        `No AML screening found for reference ${referenceId}`,
      );
    }
    return screening;
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
    const mapping = mapGlobalWatchError(vendorCode);
    return new VendorNormalisedError(
      mapping.category,
      mapping.retryable,
      vendorCode,
      VendorType.AML_SCREENING,
      `GlobalWatch error [${vendorCode}]: ${mapping.action}`,
    );
  }

  private extractVendorCode(err: unknown): string {
    if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
      return err.code;
    }
    return 'unknown-error';
  }
}
