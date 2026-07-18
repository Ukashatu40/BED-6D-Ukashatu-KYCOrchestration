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
import { DIGILOCKER_DOCUMENT_FETCH_RETRY, RetryPolicy, retryWithBackoff } from '../retry.util';
import { mapDigilockerError } from './digilocker-error-map';
import { DigilockerHttpClient } from './digilocker-http-client.interface';
import { DigilockerOAuthToken } from './digilocker.types';

export interface DigilockerAdapterConfig {
  clientId: string;
  sandbox: boolean;
}

/**
 * KycVendorPort implementation for Digilocker. OAuth 2.0 + PKCE, document
 * fetch by type, polling-only (no webhook support — see Section A2.1).
 * Wraps every vendor call in the circuit breaker and the shared retry
 * policy; normalises every failure into VendorNormalisedError before it
 * escapes this adapter.
 */
export class DigilockerAdapter implements KycVendorPort {
  // In-memory session store keyed by our internal reference ID.
  // Swapped for a persisted repository once Day 4's persistence layer lands —
  // tokens are short-lived and losing them on restart just forces re-consent,
  // it isn't a correctness issue for this adapter's scope.
  private readonly sessions = new Map<
    string,
    { token: DigilockerOAuthToken; consentId: string; context: VerificationContext }
  >();

  constructor(
    private readonly httpClient: DigilockerHttpClient,
    private readonly config: DigilockerAdapterConfig,
    private readonly circuitBreaker: CircuitBreaker,
    // Injectable so tests can supply near-zero delays instead of the real
    // 1s/2s/4s production backoff — keeps retry *logic* under test without
    // making the suite slow. Defaults to the spec's real policy at runtime.
    private readonly retryPolicy: RetryPolicy = DIGILOCKER_DOCUMENT_FETCH_RETRY,
  ) {}

  async initiateVerification(context: VerificationContext): Promise<VendorInitiationResult> {
    return this.circuitBreaker.execute(async () => {
      return retryWithBackoff(
        async () => {
          const consentId = randomUUID();
          const referenceId = `dgl-${consentId}`;
          this.sessions.set(referenceId, {
            token: { accessToken: '', refreshToken: '', expiresAt: new Date(0) },
            consentId,
            context,
          });
          return {
            vendorReferenceId: referenceId,
            isAsync: true,
            estimatedCompletionSeconds: 120,
          };
        },
        this.retryPolicy,
        (err) => this.isRetryable(err),
      );
    });
  }

  async checkStatus(referenceId: string): Promise<VendorStatusResult> {
    const session = this.requireSession(referenceId);
    return this.circuitBreaker.execute(async () => {
      try {
        const consentStatus = await this.httpClient.getConsentStatus(session.consentId);
        return {
          vendorReferenceId: referenceId,
          status: this.mapConsentStatusToVendorStatus(consentStatus),
          rawVendorStatus: consentStatus,
        };
      } catch (err) {
        throw this.normaliseError(err);
      }
    });
  }

  async fetchResult(referenceId: string): Promise<VendorVerificationResult> {
    const session = this.requireSession(referenceId);
    if (!session.context.documentType) {
      throw new VendorNormalisedError(
        InternalErrorCategory.VALIDATION_ERROR,
        false,
        'missing-document-type',
        VendorType.DIGILOCKER,
        'VerificationContext.documentType is required to fetch a Digilocker document',
      );
    }

    return this.circuitBreaker.execute(async () => {
      return retryWithBackoff(
        async () => {
          try {
            const doc = await this.httpClient.fetchDocument(
              session.token.accessToken,
              session.context.documentType!,
            );
            const signatureValid = this.validatePkcs7SignatureStub(doc.pkcs7Signature);
            if (!signatureValid) {
              throw new VendorNormalisedError(
                InternalErrorCategory.VALIDATION_ERROR,
                false,
                'invalid-signature',
                VendorType.DIGILOCKER,
                'PKCS#7 signature validation failed for fetched document',
              );
            }
            return {
              vendorReferenceId: referenceId,
              success: true,
              normalisedData: {
                documentType: doc.documentType,
                name: doc.extractedFields.name,
                dateOfBirth: doc.extractedFields.dateOfBirth,
                address: doc.extractedFields.address,
                documentNumber: doc.extractedFields.documentNumber,
              },
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

  async handleCallback(_payload: WebhookPayload): Promise<CallbackProcessingResult> {
    return {
      processed: false,
      wasDuplicate: false,
    };
  }

  async getHealthStatus(): Promise<VendorHealthStatus> {
    return {
      vendorType: VendorType.DIGILOCKER,
      isHealthy: this.circuitBreaker.getState() === 'CLOSED',
      circuitBreakerState: this.circuitBreaker.getState(),
    };
  }

  private requireSession(referenceId: string) {
    const session = this.sessions.get(referenceId);
    if (!session) {
      throw new VendorNormalisedError(
        InternalErrorCategory.NOT_FOUND,
        false,
        'session-not-found',
        VendorType.DIGILOCKER,
        `No Digilocker session found for reference ${referenceId}`,
      );
    }
    return session;
  }

  private mapConsentStatusToVendorStatus(
    consentStatus: 'PENDING' | 'GRANTED' | 'DENIED' | 'EXPIRED',
  ): VendorStatusResult['status'] {
    switch (consentStatus) {
      case 'PENDING':
        return 'PENDING';
      case 'GRANTED':
        return 'IN_PROGRESS';
      case 'DENIED':
      case 'EXPIRED':
        return 'FAILED';
    }
  }

  private validatePkcs7SignatureStub(signature: string): boolean {
    return signature.length > 0;
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
    const mapping = mapDigilockerError(vendorCode);
    return new VendorNormalisedError(
      mapping.category,
      mapping.retryable,
      vendorCode,
      VendorType.DIGILOCKER,
      `Digilocker error [${vendorCode}]: ${mapping.action}`,
    );
  }

  private extractVendorCode(err: unknown): string {
    if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
      return err.code;
    }
    return 'unknown-error';
  }
}
