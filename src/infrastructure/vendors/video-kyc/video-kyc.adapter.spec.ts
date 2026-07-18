// src/infrastructure/vendors/video-kyc/video-kyc.adapter.spec.ts
import { createHmac } from 'crypto';
import { VideoKycAdapter } from './video-kyc.adapter';
import { VideoKycHttpClient } from './video-kyc-http-client.interface';
import { CircuitBreaker } from '../circuit-breaker';
import { InMemoryWebhookDeduplication } from '../in-memory-webhook-deduplication';
import { RetryPolicy } from '../retry.util';
import {
  InternalErrorCategory,
  VendorType,
  WebhookPayload,
} from '../../../application/ports/kyc-vendor.port';
import { KycTier } from '../../../domain/value-objects/kyc-tier.enum';
import { describe, it, expect } from '@jest/globals';

const HMAC_SECRET = 'test-secret';

const cbConfig = {
  vendorType: 'VIDEO_KYC',
  failureThresholdPercent: 50,
  rollingWindowMs: 60_000,
  minimumRequestsInWindow: 100,
  openStateTimeoutMs: 30_000,
};

const FAST_RETRY: RetryPolicy = {
  maxRetries: 2,
  initialDelayMs: 1,
  backoffMultiplier: 2,
  maxDelayMs: 4,
  jitterMaxMs: 1,
};

function makeMockClient(overrides: Partial<VideoKycHttpClient> = {}): VideoKycHttpClient {
  return {
    createSession: jest.fn(),
    fetchRecordingUrl: jest.fn(),
    ...overrides,
  };
}

function makeAdapter(client: VideoKycHttpClient, dedup = new InMemoryWebhookDeduplication()) {
  return new VideoKycAdapter(
    client,
    {
      livenessThreshold: 0.85,
      faceMatchThreshold: 90,
      sessionTimeoutSeconds: 3600,
      webhookHmacSecret: HMAC_SECRET,
    },
    new CircuitBreaker(cbConfig),
    dedup,
    FAST_RETRY,
  );
}

function signedWebhook(body: object, eventId = 'evt-001'): WebhookPayload {
  const rawBody = Buffer.from(JSON.stringify({ eventId, ...body }));
  const signature = createHmac('sha256', HMAC_SECRET).update(rawBody).digest('hex');
  return {
    vendorType: VendorType.VIDEO_KYC,
    eventId,
    eventType: (body as any).event,
    signature,
    rawBody,
    headers: {},
  };
}

const baseContext = {
  customerId: 'cust-001',
  requestId: 'req-001',
  tier: KycTier.EDD,
  metadata: {},
};

describe('VideoKycAdapter', () => {
  describe('initiateVerification', () => {
    it('creates a session and returns an async initiation result', async () => {
      const client = makeMockClient({
        createSession: jest
          .fn()
          .mockResolvedValue({ sessionId: 'sess-001', sessionUrl: 'https://x/y' }),
      });
      const adapter = makeAdapter(client);
      const result = await adapter.initiateVerification(baseContext as any);
      expect(result.isAsync).toBe(true);
      expect(result.vendorReferenceId).toBe('sess-001');
    });
  });

  describe('fetchResult before webhook arrives', () => {
    it('rejects with CONFLICT when session is still pending', async () => {
      const client = makeMockClient({
        createSession: jest
          .fn()
          .mockResolvedValue({ sessionId: 'sess-002', sessionUrl: 'https://x/y' }),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      await expect(adapter.fetchResult(vendorReferenceId)).rejects.toMatchObject({
        category: InternalErrorCategory.CONFLICT,
      });
    });
  });

  describe('handleCallback — HMAC verification', () => {
    it('rejects a webhook with an invalid signature', async () => {
      const adapter = makeAdapter(makeMockClient());
      const payload: WebhookPayload = {
        vendorType: VendorType.VIDEO_KYC,
        eventId: 'evt-bad',
        eventType: 'session.completed',
        signature: 'deadbeef'.repeat(8), // wrong signature, right length
        rawBody: Buffer.from('{}'),
        headers: {},
      };
      await expect(adapter.handleCallback(payload)).rejects.toMatchObject({
        category: InternalErrorCategory.AUTHENTICATION_ERROR,
      });
    });

    it('accepts a webhook with a valid signature', async () => {
      const client = makeMockClient({
        createSession: jest
          .fn()
          .mockResolvedValue({ sessionId: 'sess-003', sessionUrl: 'https://x/y' }),
      });
      const adapter = makeAdapter(client);
      await adapter.initiateVerification(baseContext as any);

      const payload = signedWebhook({
        event: 'session.completed',
        sessionId: 'sess-003',
        livenessScore: 0.92,
        faceMatchConfidence: 95,
      });
      const result = await adapter.handleCallback(payload);
      expect(result.processed).toBe(true);
      expect(result.wasDuplicate).toBe(false);
    });
  });

  describe('handleCallback — idempotency', () => {
    it('acknowledges a duplicate event_id without reprocessing', async () => {
      const client = makeMockClient({
        createSession: jest
          .fn()
          .mockResolvedValue({ sessionId: 'sess-004', sessionUrl: 'https://x/y' }),
      });
      const dedup = new InMemoryWebhookDeduplication();
      const adapter = makeAdapter(client, dedup);
      await adapter.initiateVerification(baseContext as any);

      const payload = signedWebhook(
        {
          event: 'session.completed',
          sessionId: 'sess-004',
          livenessScore: 0.9,
          faceMatchConfidence: 92,
        },
        'evt-dup',
      );
      const first = await adapter.handleCallback(payload);
      expect(first.wasDuplicate).toBe(false);

      const second = await adapter.handleCallback(payload);
      expect(second.wasDuplicate).toBe(true);
      expect(second.processed).toBe(true);
    });

    it('processes the same session receiving session.started then session.completed as two distinct events', async () => {
      const client = makeMockClient({
        createSession: jest
          .fn()
          .mockResolvedValue({ sessionId: 'sess-005', sessionUrl: 'https://x/y' }),
      });
      const adapter = makeAdapter(client);
      await adapter.initiateVerification(baseContext as any);

      const started = signedWebhook(
        { event: 'session.started', sessionId: 'sess-005' },
        'evt-start',
      );
      await adapter.handleCallback(started);

      const completed = signedWebhook(
        {
          event: 'session.completed',
          sessionId: 'sess-005',
          livenessScore: 0.9,
          faceMatchConfidence: 92,
        },
        'evt-complete',
      );
      const result = await adapter.handleCallback(completed);
      expect(result.wasDuplicate).toBe(false);
    });
  });

  describe('handleCallback — session outcomes', () => {
    it('stores liveness score and face match confidence on session.completed', async () => {
      const client = makeMockClient({
        createSession: jest
          .fn()
          .mockResolvedValue({ sessionId: 'sess-006', sessionUrl: 'https://x/y' }),
      });
      const adapter = makeAdapter(client);
      await adapter.initiateVerification(baseContext as any);

      await adapter.handleCallback(
        signedWebhook({
          event: 'session.completed',
          sessionId: 'sess-006',
          livenessScore: 0.88,
          faceMatchConfidence: 97,
          recordingUrl: 'https://recordings/sess-006.mp4',
        }),
      );

      const result = await adapter.fetchResult('sess-006');
      expect(result.success).toBe(true);
      expect(result.normalisedData.livenessScore).toBe(0.88);
      expect(result.normalisedData.faceMatchConfidence).toBe(97);
    });

    it('surfaces a failed session with its mapped error category', async () => {
      const client = makeMockClient({
        createSession: jest
          .fn()
          .mockResolvedValue({ sessionId: 'sess-007', sessionUrl: 'https://x/y' }),
      });
      const adapter = makeAdapter(client);
      await adapter.initiateVerification(baseContext as any);

      await adapter.handleCallback(
        signedWebhook({
          event: 'session.failed',
          sessionId: 'sess-007',
          errorCode: 'liveness-failed',
        }),
      );

      const result = await adapter.fetchResult('sess-007');
      expect(result.success).toBe(false);
      expect(result.errorCategory).toBe(InternalErrorCategory.VALIDATION_ERROR);
      expect(result.vendorErrorCode).toBe('liveness-failed');
    });

    it('treats session.expired as a failure', async () => {
      const client = makeMockClient({
        createSession: jest
          .fn()
          .mockResolvedValue({ sessionId: 'sess-008', sessionUrl: 'https://x/y' }),
      });
      const adapter = makeAdapter(client);
      await adapter.initiateVerification(baseContext as any);

      await adapter.handleCallback(
        signedWebhook({ event: 'session.expired', sessionId: 'sess-008' }),
      );

      const result = await adapter.fetchResult('sess-008');
      expect(result.success).toBe(false);
    });

    it('rejects a webhook referencing an unknown session', async () => {
      const adapter = makeAdapter(makeMockClient());
      await expect(
        adapter.handleCallback(
          signedWebhook({ event: 'session.completed', sessionId: 'ghost-session' }),
        ),
      ).rejects.toMatchObject({ category: InternalErrorCategory.NOT_FOUND });
    });
  });

  describe('error code mapping', () => {
    it('maps face-mismatch to VALIDATION_ERROR, retryable', async () => {
      const client = makeMockClient({
        createSession: jest
          .fn()
          .mockResolvedValue({ sessionId: 'sess-009', sessionUrl: 'https://x/y' }),
      });
      const adapter = makeAdapter(client);
      await adapter.initiateVerification(baseContext as any);
      await adapter.handleCallback(
        signedWebhook({
          event: 'session.failed',
          sessionId: 'sess-009',
          errorCode: 'face-mismatch',
        }),
      );
      const result = await adapter.fetchResult('sess-009');
      expect(result.errorCategory).toBe(InternalErrorCategory.VALIDATION_ERROR);
    });

    it('maps concurrent-session-limit-reached to RATE_LIMITED and retries session creation', async () => {
      const client = makeMockClient({
        createSession: jest
          .fn()
          .mockRejectedValueOnce({ code: 'concurrent-session-limit-reached' })
          .mockResolvedValueOnce({ sessionId: 'sess-010', sessionUrl: 'https://x/y' }),
      });
      const adapter = makeAdapter(client);
      const result = await adapter.initiateVerification(baseContext as any);
      expect(result.vendorReferenceId).toBe('sess-010');
      expect(client.createSession).toHaveBeenCalledTimes(2);
    });

    it('falls back to VENDOR_ERROR for an unmapped failure code', async () => {
      const client = makeMockClient({
        createSession: jest
          .fn()
          .mockResolvedValue({ sessionId: 'sess-011', sessionUrl: 'https://x/y' }),
      });
      const adapter = makeAdapter(client);
      await adapter.initiateVerification(baseContext as any);
      await adapter.handleCallback(
        signedWebhook({
          event: 'session.failed',
          sessionId: 'sess-011',
          errorCode: 'something-new',
        }),
      );
      const result = await adapter.fetchResult('sess-011');
      expect(result.errorCategory).toBe(InternalErrorCategory.VENDOR_ERROR);
    });
  });

  describe('timeout handling', () => {
    it('exhausts retries and surfaces the final error on session creation failure', async () => {
      const client = makeMockClient({
        createSession: jest.fn().mockRejectedValue({ code: 'poor-connectivity' }),
      });
      const adapter = makeAdapter(client);
      await expect(adapter.initiateVerification(baseContext as any)).rejects.toMatchObject({
        vendorErrorCode: 'poor-connectivity',
      });
      expect(client.createSession).toHaveBeenCalledTimes(3); // initial + 2 retries
    });
  });

  describe('getHealthStatus', () => {
    it('reports healthy when circuit is CLOSED', async () => {
      const adapter = makeAdapter(makeMockClient());
      const health = await adapter.getHealthStatus();
      expect(health.isHealthy).toBe(true);
    });
  });
});
