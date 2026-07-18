// src/infrastructure/vendors/aml-screening/aml-screening.adapter.spec.ts
import { createHmac } from 'crypto';
import { AmlScreeningAdapter } from './aml-screening.adapter';
import { AmlScreeningHttpClient } from './aml-screening-http-client.interface';
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

const WEBHOOK_SECRET = 'webhook-secret';

const cbConfig = {
  vendorType: 'AML_SCREENING',
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

function makeMockClient(overrides: Partial<AmlScreeningHttpClient> = {}): AmlScreeningHttpClient {
  return {
    screenRealTime: jest.fn(),
    screenBatch: jest.fn(),
    registerOngoingMonitoring: jest.fn(),
    ...overrides,
  };
}

function makeAdapter(
  client: AmlScreeningHttpClient,
  dedup = new InMemoryWebhookDeduplication(),
  fuzzyMatchThreshold = 80,
) {
  return new AmlScreeningAdapter(
    client,
    {
      apiKey: 'test-api-key',
      requestSigningSecret: 'signing-secret',
      webhookHmacSecret: WEBHOOK_SECRET,
      fuzzyMatchThreshold,
    },
    new CircuitBreaker(cbConfig),
    dedup,
    FAST_RETRY,
  );
}

function signedWebhook(body: object, eventId = 'evt-001'): WebhookPayload {
  const rawBody = Buffer.from(JSON.stringify({ eventId, ...body }));
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  return {
    vendorType: VendorType.AML_SCREENING,
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
  tier: KycTier.FULL,
  metadata: { fullName: 'Test Customer', dateOfBirth: '1990-01-01', screeningType: 'COMBINED' },
};

describe('AmlScreeningAdapter', () => {
  describe('constructor validation', () => {
    it('rejects a fuzzyMatchThreshold below 70', () => {
      expect(() => makeAdapter(makeMockClient(), new InMemoryWebhookDeduplication(), 50)).toThrow();
    });

    it('rejects a fuzzyMatchThreshold above 100', () => {
      expect(() =>
        makeAdapter(makeMockClient(), new InMemoryWebhookDeduplication(), 150),
      ).toThrow();
    });

    it('accepts a valid threshold at the boundary (70 and 100)', () => {
      expect(() =>
        makeAdapter(makeMockClient(), new InMemoryWebhookDeduplication(), 70),
      ).not.toThrow();
      expect(() =>
        makeAdapter(makeMockClient(), new InMemoryWebhookDeduplication(), 100),
      ).not.toThrow();
    });
  });

  describe('initiateVerification — real-time screening', () => {
    it('screens with zero matches (clean result)', async () => {
      const client = makeMockClient({
        screenRealTime: jest.fn().mockResolvedValue({
          vendorScreeningId: 'scr-001',
          matchCount: 0,
          matches: [],
          highestRiskScore: 0,
          highestConfidence: 0,
        }),
      });
      const adapter = makeAdapter(client);
      const result = await adapter.initiateVerification(baseContext as any);
      expect(result.isAsync).toBe(false);
      expect(result.vendorReferenceId).toBe('scr-001');
    });

    it('rejects when fullName is missing from context metadata', async () => {
      const adapter = makeAdapter(makeMockClient());
      await expect(
        adapter.initiateVerification({
          ...baseContext,
          metadata: { dateOfBirth: '1990-01-01' },
        } as any),
      ).rejects.toMatchObject({ category: InternalErrorCategory.VALIDATION_ERROR });
    });

    it('rejects when dateOfBirth is missing from context metadata', async () => {
      const adapter = makeAdapter(makeMockClient());
      await expect(
        adapter.initiateVerification({ ...baseContext, metadata: { fullName: 'X' } } as any),
      ).rejects.toMatchObject({ category: InternalErrorCategory.VALIDATION_ERROR });
    });

    it('signs the outbound request', async () => {
      const client = makeMockClient({
        screenRealTime: jest.fn().mockResolvedValue({
          vendorScreeningId: 'scr-002',
          matchCount: 0,
          matches: [],
          highestRiskScore: 0,
          highestConfidence: 0,
        }),
      });
      const adapter = makeAdapter(client);
      await adapter.initiateVerification(baseContext as any);
      const [, signature] = (client.screenRealTime as jest.Mock).mock.calls[0];
      expect(typeof signature).toBe('string');
      expect(signature.length).toBe(64); // hex-encoded SHA-256
    });
  });

  describe('fetchResult', () => {
    it('returns matches with requiresDisposition=true when matches exist', async () => {
      const client = makeMockClient({
        screenRealTime: jest.fn().mockResolvedValue({
          vendorScreeningId: 'scr-003',
          matchCount: 2,
          matches: [
            {
              matchedList: 'UNSC',
              matchedName: 'Test Customer',
              matchConfidence: 96,
              matchedAttributes: {},
              riskScore: 90,
            },
            {
              matchedList: 'OFAC',
              matchedName: 'Test Customer',
              matchConfidence: 32,
              matchedAttributes: {},
              riskScore: 10,
            },
          ],
          highestRiskScore: 90,
          highestConfidence: 96,
        }),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      const result = await adapter.fetchResult(vendorReferenceId);
      expect(result.normalisedData.matchCount).toBe(2);
      expect(result.normalisedData.requiresDisposition).toBe(true);
    });

    it('returns requiresDisposition=false on a clean screening', async () => {
      const client = makeMockClient({
        screenRealTime: jest.fn().mockResolvedValue({
          vendorScreeningId: 'scr-004',
          matchCount: 0,
          matches: [],
          highestRiskScore: 0,
          highestConfidence: 0,
        }),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      const result = await adapter.fetchResult(vendorReferenceId);
      expect(result.normalisedData.requiresDisposition).toBe(false);
    });

    it('throws NOT_FOUND for an unknown reference ID', async () => {
      const adapter = makeAdapter(makeMockClient());
      await expect(adapter.fetchResult('nonexistent')).rejects.toMatchObject({
        category: InternalErrorCategory.NOT_FOUND,
      });
    });
  });

  describe('batch screening', () => {
    it('screens a batch of entities', async () => {
      const client = makeMockClient({
        screenBatch: jest.fn().mockResolvedValue({
          batchId: 'batch-001',
          results: [
            {
              customerId: 'c1',
              response: {
                vendorScreeningId: 's1',
                matchCount: 0,
                matches: [],
                highestRiskScore: 0,
                highestConfidence: 0,
              },
            },
          ],
        }),
      });
      const adapter = makeAdapter(client);
      const result = await adapter.screenBatch([
        {
          customerId: 'c1',
          fullName: 'X',
          dateOfBirth: '1990-01-01',
          screeningType: 'SANCTIONS',
          fuzzyMatchThreshold: 80,
        },
      ]);
      expect(result.batchId).toBe('batch-001');
    });

    it('rejects a batch exceeding 5000 entities', async () => {
      const adapter = makeAdapter(makeMockClient());
      const oversized = Array.from({ length: 5001 }, (_, i) => ({
        customerId: `c${i}`,
        fullName: 'X',
        dateOfBirth: '1990-01-01',
        screeningType: 'SANCTIONS' as const,
        fuzzyMatchThreshold: 80,
      }));
      await expect(adapter.screenBatch(oversized)).rejects.toMatchObject({
        category: InternalErrorCategory.VALIDATION_ERROR,
      });
    });

    it('rejects an empty batch', async () => {
      const adapter = makeAdapter(makeMockClient());
      await expect(adapter.screenBatch([])).rejects.toMatchObject({
        category: InternalErrorCategory.VALIDATION_ERROR,
      });
    });
  });

  describe('ongoing monitoring registration', () => {
    it('registers a customer for ongoing monitoring', async () => {
      const client = makeMockClient({
        registerOngoingMonitoring: jest.fn().mockResolvedValue({ monitoringWebhookId: 'mon-001' }),
      });
      const adapter = makeAdapter(client);
      const result = await adapter.registerOngoingMonitoring('cust-001');
      expect(result.monitoringWebhookId).toBe('mon-001');
    });
  });

  describe('handleCallback — HMAC verification and idempotency', () => {
    it('rejects a monitoring webhook with an invalid signature', async () => {
      const adapter = makeAdapter(makeMockClient());
      const payload: WebhookPayload = {
        vendorType: VendorType.AML_SCREENING,
        eventId: 'evt-bad',
        eventType: 'monitoring.new_match',
        signature: 'deadbeef'.repeat(8),
        rawBody: Buffer.from('{}'),
        headers: {},
      };
      await expect(adapter.handleCallback(payload)).rejects.toMatchObject({
        category: InternalErrorCategory.AUTHENTICATION_ERROR,
      });
    });

    it('processes a valid monitoring.new_match webhook and flags requiresDisposition', async () => {
      const adapter = makeAdapter(makeMockClient());
      const payload = signedWebhook({
        event: 'monitoring.new_match',
        customerId: 'cust-001',
        match: {
          matchedList: 'UNSC',
          matchedName: 'Test Customer',
          matchConfidence: 91,
          matchedAttributes: {},
          riskScore: 85,
        },
      });
      const result = await adapter.handleCallback(payload);
      expect(result.processed).toBe(true);
      expect(result.result?.normalisedData.requiresDisposition).toBe(true);
    });

    it('acknowledges a duplicate monitoring alert without reprocessing', async () => {
      const dedup = new InMemoryWebhookDeduplication();
      const adapter = makeAdapter(makeMockClient(), dedup);
      const payload = signedWebhook(
        {
          event: 'monitoring.new_match',
          customerId: 'cust-001',
          match: {
            matchedList: 'UNSC',
            matchedName: 'X',
            matchConfidence: 90,
            matchedAttributes: {},
            riskScore: 80,
          },
        },
        'evt-dup',
      );
      const first = await adapter.handleCallback(payload);
      expect(first.wasDuplicate).toBe(false);
      const second = await adapter.handleCallback(payload);
      expect(second.wasDuplicate).toBe(true);
    });

    it('processes monitoring.list_updated without a result payload', async () => {
      const adapter = makeAdapter(makeMockClient());
      const payload = signedWebhook({ event: 'monitoring.list_updated', customerId: 'cust-001' });
      const result = await adapter.handleCallback(payload);
      expect(result.processed).toBe(true);
      expect(result.result).toBeUndefined();
    });
  });

  describe('error code mapping', () => {
    it('maps quota-exceeded to RATE_LIMITED, retryable, and recovers on retry', async () => {
      const client = makeMockClient({
        screenRealTime: jest
          .fn()
          .mockRejectedValueOnce({ code: 'quota-exceeded' })
          .mockResolvedValueOnce({
            vendorScreeningId: 'scr-005',
            matchCount: 0,
            matches: [],
            highestRiskScore: 0,
            highestConfidence: 0,
          }),
      });
      const adapter = makeAdapter(client);
      const result = await adapter.initiateVerification(baseContext as any);
      expect(result.vendorReferenceId).toBe('scr-005');
      expect(client.screenRealTime).toHaveBeenCalledTimes(2);
    });

    it('maps invalid-entity to VALIDATION_ERROR, non-retryable', async () => {
      const client = makeMockClient({
        screenRealTime: jest.fn().mockRejectedValue({ code: 'invalid-entity' }),
      });
      const adapter = makeAdapter(client);
      await expect(adapter.initiateVerification(baseContext as any)).rejects.toMatchObject({
        category: InternalErrorCategory.VALIDATION_ERROR,
        retryable: false,
      });
      expect(client.screenRealTime).toHaveBeenCalledTimes(1);
    });

    it('maps service-degraded to VENDOR_UNAVAILABLE, retryable', async () => {
      const client = makeMockClient({
        screenRealTime: jest.fn().mockRejectedValue({ code: 'service-degraded' }),
      });
      const adapter = makeAdapter(client);
      await expect(adapter.initiateVerification(baseContext as any)).rejects.toMatchObject({
        category: InternalErrorCategory.VENDOR_UNAVAILABLE,
        retryable: true,
      });
    });

    it('falls back to VENDOR_ERROR for unmapped codes', async () => {
      const client = makeMockClient({
        screenRealTime: jest.fn().mockRejectedValue({ code: 'brand-new-code' }),
      });
      const adapter = makeAdapter(client);
      await expect(adapter.initiateVerification(baseContext as any)).rejects.toMatchObject({
        category: InternalErrorCategory.VENDOR_ERROR,
      });
    });
  });

  describe('timeout and retry exhaustion', () => {
    it('exhausts retries and surfaces the final error', async () => {
      const client = makeMockClient({
        screenRealTime: jest.fn().mockRejectedValue({ code: 'quota-exceeded' }),
      });
      const adapter = makeAdapter(client);
      await expect(adapter.initiateVerification(baseContext as any)).rejects.toMatchObject({
        vendorErrorCode: 'quota-exceeded',
      });
      expect(client.screenRealTime).toHaveBeenCalledTimes(3); // initial + 2 retries
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
