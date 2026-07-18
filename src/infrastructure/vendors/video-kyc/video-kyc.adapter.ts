// src/infrastructure/vendors/video-kyc/video-kyc.adapter.ts
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
import { RetryPolicy, VIDEO_KYC_SESSION_CREATE_RETRY, retryWithBackoff } from '../retry.util';
import { verifyHmacSignature } from '../webhook-verification.util';
import { mapSigniVisionError } from './video-kyc-error-map';
import { VideoKycHttpClient } from './video-kyc-http-client.interface';
import { SigniVisionWebhookPayload } from './video-kyc.types';

const WEBHOOK_DEDUP_TTL_SECONDS = 72 * 60 * 60; // 72-hour window per spec

export interface VideoKycAdapterConfig {
  livenessThreshold: number;
  faceMatchThreshold: number;
  sessionTimeoutSeconds: number;
  webhookHmacSecret: string;
}

type SessionState = {
  customerId: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  result?: {
    livenessScore: number;
    faceMatchConfidence: number;
    recordingUrl?: string;
  };
  errorCode?: string;
};

/**
 * KycVendorPort implementation for the SigniVision video KYC provider.
 * Session creation is synchronous; the actual verification outcome arrives
 * asynchronously via webhook (session.completed/failed/expired) — this is
 * the one adapter in the VAL that's genuinely event-driven end to end, which
 * is why VENDOR_CALLBACK_AWAITED exists as a distinct state machine state
 * (Section A3.4) specifically for this vendor's flow.
 */
export class VideoKycAdapter implements KycVendorPort {
  private readonly sessions = new Map<string, SessionState>();

  constructor(
    private readonly httpClient: VideoKycHttpClient,
    private readonly config: VideoKycAdapterConfig,
    private readonly circuitBreaker: CircuitBreaker,
    private readonly dedup: WebhookDeduplicationPort,
    private readonly retryPolicy: RetryPolicy = VIDEO_KYC_SESSION_CREATE_RETRY,
  ) {}

  async initiateVerification(context: VerificationContext): Promise<VendorInitiationResult> {
    return this.circuitBreaker.execute(async () => {
      return retryWithBackoff(
        async () => {
          try {
            const { sessionId } = await this.httpClient.createSession({
              customerId: context.customerId,
              livenessThreshold: this.config.livenessThreshold,
              faceMatchThreshold: this.config.faceMatchThreshold,
              sessionTimeoutSeconds: this.config.sessionTimeoutSeconds,
            });
            this.sessions.set(sessionId, { customerId: context.customerId, status: 'PENDING' });
            return {
              vendorReferenceId: sessionId,
              isAsync: true,
              estimatedCompletionSeconds: this.config.sessionTimeoutSeconds,
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
    const session = this.requireSession(referenceId);
    return {
      vendorReferenceId: referenceId,
      status:
        session.status === 'PENDING'
          ? 'PENDING'
          : session.status === 'COMPLETED'
            ? 'COMPLETED'
            : 'FAILED',
      rawVendorStatus: session.status,
    };
  }

  async fetchResult(referenceId: string): Promise<VendorVerificationResult> {
    const session = this.requireSession(referenceId);

    if (session.status === 'PENDING') {
      throw new VendorNormalisedError(
        InternalErrorCategory.CONFLICT,
        false,
        'session-still-pending',
        VendorType.VIDEO_KYC,
        'Cannot fetch result before the video session webhook has been received',
      );
    }

    if (session.status === 'FAILED') {
      const mapping = mapSigniVisionError(session.errorCode ?? 'unknown-error');
      return {
        vendorReferenceId: referenceId,
        success: false,
        normalisedData: {},
        errorCategory: mapping.category,
        vendorErrorCode: session.errorCode,
      };
    }

    return {
      vendorReferenceId: referenceId,
      success: true,
      normalisedData: {
        livenessScore: session.result!.livenessScore,
        faceMatchConfidence: session.result!.faceMatchConfidence,
        recordingUrl: session.result!.recordingUrl,
      },
    };
  }

  /**
   * Handles the session.completed/failed/expired webhook. HMAC-verified,
   * idempotent (duplicate deliveries of the same event_id are acknowledged
   * without reprocessing per the mandatory dedup pitfall), and stores the
   * result for a subsequent fetchResult call.
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
        VendorType.VIDEO_KYC,
        'SigniVision webhook HMAC signature verification failed',
      );
    }

    const alreadyProcessed = await this.dedup.hasBeenProcessed(payload.eventId);
    if (alreadyProcessed) {
      return { processed: true, wasDuplicate: true };
    }

    const body: SigniVisionWebhookPayload = JSON.parse(payload.rawBody.toString('utf-8'));
    const session = this.sessions.get(body.sessionId);
    if (!session) {
      throw new VendorNormalisedError(
        InternalErrorCategory.NOT_FOUND,
        false,
        'unknown-session',
        VendorType.VIDEO_KYC,
        `Webhook references unknown session ${body.sessionId}`,
      );
    }

    switch (body.event) {
      case 'session.completed':
        session.status = 'COMPLETED';
        session.result = {
          livenessScore: body.livenessScore ?? 0,
          faceMatchConfidence: body.faceMatchConfidence ?? 0,
          recordingUrl: body.recordingUrl,
        };
        break;
      case 'session.failed':
      case 'session.expired':
        session.status = 'FAILED';
        session.errorCode = body.errorCode ?? body.event;
        break;
      case 'session.started':
        // No state change needed — session already marked PENDING at creation.
        break;
    }

    await this.dedup.markProcessed(payload.eventId, WEBHOOK_DEDUP_TTL_SECONDS);

    return {
      processed: true,
      wasDuplicate: false,
      result:
        session.status === 'COMPLETED'
          ? {
              vendorReferenceId: body.sessionId,
              success: true,
              normalisedData: {
                livenessScore: session.result!.livenessScore,
                faceMatchConfidence: session.result!.faceMatchConfidence,
              },
            }
          : undefined,
    };
  }

  async getHealthStatus(): Promise<VendorHealthStatus> {
    return {
      vendorType: VendorType.VIDEO_KYC,
      isHealthy: this.circuitBreaker.getState() === 'CLOSED',
      circuitBreakerState: this.circuitBreaker.getState(),
    };
  }

  private requireSession(referenceId: string): SessionState {
    const session = this.sessions.get(referenceId);
    if (!session) {
      throw new VendorNormalisedError(
        InternalErrorCategory.NOT_FOUND,
        false,
        'session-not-found',
        VendorType.VIDEO_KYC,
        `No video KYC session found for reference ${referenceId}`,
      );
    }
    return session;
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
    const mapping = mapSigniVisionError(vendorCode);
    return new VendorNormalisedError(
      mapping.category,
      mapping.retryable,
      vendorCode,
      VendorType.VIDEO_KYC,
      `SigniVision error [${vendorCode}]: ${mapping.action}`,
    );
  }

  private extractVendorCode(err: unknown): string {
    if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
      return err.code;
    }
    return 'unknown-error';
  }
}
