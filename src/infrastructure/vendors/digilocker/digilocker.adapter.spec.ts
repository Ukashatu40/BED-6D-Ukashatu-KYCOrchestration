// src/infrastructure/vendors/digilocker/digilocker.adapter.spec.ts
import { DigilockerAdapter } from './digilocker.adapter';
import { DigilockerHttpClient } from './digilocker-http-client.interface';
import { CircuitBreaker } from '../circuit-breaker';
import { VendorNormalisedError } from '../../../application/ports/internal-error';
import { InternalErrorCategory } from '../../../application/ports/kyc-vendor.port';
import { DocumentType } from '../../../domain/value-objects/document-type.enum';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const cbConfig = {
  vendorType: 'DIGILOCKER',
  failureThresholdPercent: 50,
  rollingWindowMs: 60_000,
  minimumRequestsInWindow: 100, // effectively disabled for adapter-level tests
  openStateTimeoutMs: 30_000,
};

function makeMockClient(overrides: Partial<DigilockerHttpClient> = {}): DigilockerHttpClient {
  return {
    exchangeAuthCode: jest.fn(),
    refreshAccessToken: jest.fn(),
    revokeToken: jest.fn(),
    fetchDocument: jest.fn(),
    getConsentStatus: jest.fn(),
    ...overrides,
  };
}

function makeAdapter(client: DigilockerHttpClient) {
  return new DigilockerAdapter(
    client,
    { clientId: 'test-client', sandbox: true },
    new CircuitBreaker(cbConfig),
  );
}

const baseContext = {
  customerId: 'cust-001',
  requestId: 'req-001',
  tier: 'MINIMUM' as const,
  documentType: DocumentType.AADHAAR,
  metadata: {},
};

describe('DigilockerAdapter', () => {
  describe('initiateVerification', () => {
    it('returns an async initiation result with a reference ID', async () => {
      const adapter = makeAdapter(makeMockClient());
      const result = await adapter.initiateVerification(baseContext as any);
      expect(result.isAsync).toBe(true);
      expect(result.vendorReferenceId).toMatch(/^dgl-/);
    });
  });

  describe('checkStatus', () => {
    it('maps GRANTED consent to IN_PROGRESS', async () => {
      const client = makeMockClient({
        getConsentStatus: jest.fn().mockResolvedValue('GRANTED'),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      const status = await adapter.checkStatus(vendorReferenceId);
      expect(status.status).toBe('IN_PROGRESS');
    });

    it('maps DENIED consent to FAILED', async () => {
      const client = makeMockClient({
        getConsentStatus: jest.fn().mockResolvedValue('DENIED'),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      const status = await adapter.checkStatus(vendorReferenceId);
      expect(status.status).toBe('FAILED');
    });

    it('throws NOT_FOUND for an unknown reference ID', async () => {
      const adapter = makeAdapter(makeMockClient());
      await expect(adapter.checkStatus('nonexistent')).rejects.toMatchObject({
        category: InternalErrorCategory.NOT_FOUND,
      });
    });
  });

  describe('fetchResult — happy path', () => {
    it('fetches and normalises a document with a valid signature', async () => {
      const client = makeMockClient({
        fetchDocument: jest.fn().mockResolvedValue({
          documentType: DocumentType.AADHAAR,
          base64Content: 'ZGF0YQ==',
          pkcs7Signature: 'valid-signature-bytes',
          extractedFields: {
            name: 'Test Customer',
            dateOfBirth: '1990-01-01',
            documentNumber: '1234-5678-9012',
          },
        }),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      const result = await adapter.fetchResult(vendorReferenceId);
      expect(result.success).toBe(true);
      expect(result.normalisedData.name).toBe('Test Customer');
    });

    it('rejects with VALIDATION_ERROR when documentType is missing from context', async () => {
      const adapter = makeAdapter(makeMockClient());
      const { vendorReferenceId } = await adapter.initiateVerification({
        ...baseContext,
        documentType: undefined,
      } as any);
      await expect(adapter.fetchResult(vendorReferenceId)).rejects.toMatchObject({
        category: InternalErrorCategory.VALIDATION_ERROR,
      });
    });

    it('rejects when PKCS#7 signature is empty (fails validation stub)', async () => {
      const client = makeMockClient({
        fetchDocument: jest.fn().mockResolvedValue({
          documentType: DocumentType.AADHAAR,
          base64Content: 'ZGF0YQ==',
          pkcs7Signature: '',
          extractedFields: { name: 'X', dateOfBirth: '1990-01-01', documentNumber: '123' },
        }),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      await expect(adapter.fetchResult(vendorReferenceId)).rejects.toMatchObject({
        category: InternalErrorCategory.VALIDATION_ERROR,
        vendorErrorCode: 'invalid-signature',
      });
    });
  });

  describe('error code mapping — each category', () => {
    it('maps consent-expired to VALIDATION_ERROR, non-retryable', async () => {
      const client = makeMockClient({
        fetchDocument: jest.fn().mockRejectedValue({ code: 'consent-expired' }),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      await expect(adapter.fetchResult(vendorReferenceId)).rejects.toMatchObject({
        category: InternalErrorCategory.VALIDATION_ERROR,
        retryable: false,
      });
    });

    it('maps document-not-found to NOT_FOUND, non-retryable', async () => {
      const client = makeMockClient({
        fetchDocument: jest.fn().mockRejectedValue({ code: 'document-not-found' }),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      await expect(adapter.fetchResult(vendorReferenceId)).rejects.toMatchObject({
        category: InternalErrorCategory.NOT_FOUND,
        retryable: false,
      });
    });

    it('maps rate-limited to RATE_LIMITED, retryable', async () => {
      const client = makeMockClient({
        fetchDocument: jest
          .fn()
          .mockRejectedValueOnce({ code: 'rate-limited' })
          .mockResolvedValueOnce({
            documentType: DocumentType.AADHAAR,
            base64Content: 'x',
            pkcs7Signature: 'sig',
            extractedFields: { name: 'X', dateOfBirth: '1990-01-01', documentNumber: '1' },
          }),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      const result = await adapter.fetchResult(vendorReferenceId);
      expect(result.success).toBe(true);
      expect(client.fetchDocument).toHaveBeenCalledTimes(2); // retried once and succeeded
    });

    it('maps service-unavailable to VENDOR_UNAVAILABLE, retryable', async () => {
      const client = makeMockClient({
        fetchDocument: jest.fn().mockRejectedValue({ code: 'service-unavailable' }),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      await expect(adapter.fetchResult(vendorReferenceId)).rejects.toMatchObject({
        category: InternalErrorCategory.VENDOR_UNAVAILABLE,
        retryable: true,
      });
    });

    it('falls back to VENDOR_ERROR for unmapped codes', async () => {
      const client = makeMockClient({
        fetchDocument: jest.fn().mockRejectedValue({ code: 'some-unmapped-code' }),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      await expect(adapter.fetchResult(vendorReferenceId)).rejects.toMatchObject({
        category: InternalErrorCategory.VENDOR_ERROR,
      });
    });
  });

  describe('retry behaviour', () => {
    it('exhausts retries and surfaces the final error after maxRetries', async () => {
      const client = makeMockClient({
        fetchDocument: jest.fn().mockRejectedValue({ code: 'rate-limited' }),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      await expect(adapter.fetchResult(vendorReferenceId)).rejects.toMatchObject({
        vendorErrorCode: 'rate-limited',
      });
      // initial attempt + 3 retries = 4 calls
      expect(client.fetchDocument).toHaveBeenCalledTimes(4);
    });

    it('does not retry non-retryable errors', async () => {
      const client = makeMockClient({
        fetchDocument: jest.fn().mockRejectedValue({ code: 'document-not-found' }),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      await expect(adapter.fetchResult(vendorReferenceId)).rejects.toBeDefined();
      expect(client.fetchDocument).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleCallback — no webhook support', () => {
    it('always returns processed:false since Digilocker has no webhooks', async () => {
      const adapter = makeAdapter(makeMockClient());
      const result = await adapter.handleCallback({} as any);
      expect(result.processed).toBe(false);
      expect(result.wasDuplicate).toBe(false);
    });
  });

  describe('getHealthStatus', () => {
    it('reports healthy when circuit is CLOSED', async () => {
      const adapter = makeAdapter(makeMockClient());
      const health = await adapter.getHealthStatus();
      expect(health.isHealthy).toBe(true);
      expect(health.circuitBreakerState).toBe('CLOSED');
    });
  });
});
