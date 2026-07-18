// src/infrastructure/vendors/ckyc/ckyc.adapter.spec.ts
import { CkycAdapter } from './ckyc.adapter';
import { CkycSoapClient } from './ckyc-soap-client.interface';
import { CircuitBreaker } from '../circuit-breaker';
import { RetryPolicy } from '../retry.util';
import { InternalErrorCategory } from '../../../application/ports/kyc-vendor.port';
import { KycTier } from '../../../domain/value-objects/kyc-tier.enum';
import { DocumentType } from '../../../domain/value-objects/document-type.enum';
import { describe, it, expect } from '@jest/globals';

const cbConfig = {
  vendorType: 'CKYC',
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

function makeMockClient(overrides: Partial<CkycSoapClient> = {}): CkycSoapClient {
  return {
    search: jest.fn(),
    download: jest.fn(),
    upload: jest.fn(),
    uploadBatch: jest.fn(),
    ...overrides,
  };
}

function makeAdapter(
  client: CkycSoapClient,
  certExpiry: Date = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
) {
  return new CkycAdapter(
    client,
    { certificateExpiryDate: certExpiry },
    new CircuitBreaker(cbConfig),
    FAST_RETRY,
    FAST_RETRY,
  );
}

const baseContext = {
  customerId: 'cust-001',
  requestId: 'req-001',
  tier: KycTier.FULL,
  documentType: DocumentType.PAN,
  metadata: {
    panNumber: 'ABCDE1234F',
    name: 'Test Customer',
    dateOfBirth: '1990-01-01',
    address: 'Test Address',
  },
};

describe('CkycAdapter', () => {
  describe('initiateVerification', () => {
    it('returns a synchronous initiation result with a reference ID', async () => {
      const adapter = makeAdapter(makeMockClient());
      const result = await adapter.initiateVerification(baseContext as any);
      expect(result.isAsync).toBe(false);
      expect(result.vendorReferenceId).toMatch(/^ckyc-/);
    });

    it('rejects when panNumber is missing from context metadata', async () => {
      const adapter = makeAdapter(makeMockClient());
      await expect(
        adapter.initiateVerification({ ...baseContext, metadata: {} } as any),
      ).rejects.toMatchObject({ category: InternalErrorCategory.VALIDATION_ERROR });
    });

    it('rejects when the mutual TLS certificate has already expired', async () => {
      const expiredDate = new Date(Date.now() - 1000);
      const adapter = makeAdapter(makeMockClient(), expiredDate);
      await expect(adapter.initiateVerification(baseContext as any)).rejects.toMatchObject({
        category: InternalErrorCategory.AUTHENTICATION_ERROR,
        vendorErrorCode: 'certificate-expired',
      });
    });
  });

  describe('fetchResult — existing record path (search hits)', () => {
    it('downloads and normalises an existing CKYC record', async () => {
      const client = makeMockClient({
        search: jest.fn().mockResolvedValue({ found: true, kin: '12345678901234' }),
        download: jest.fn().mockResolvedValue({
          kin: '12345678901234',
          name: 'Test Customer',
          dateOfBirth: '1990-01-01',
          address: 'Test Address',
          documents: [{ documentType: DocumentType.PAN, base64Content: 'xyz' }],
          lastUpdatedAt: '2026-01-01',
        }),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      const result = await adapter.fetchResult(vendorReferenceId);
      expect(result.success).toBe(true);
      expect(result.normalisedData.source).toBe('CKYC_EXISTING_RECORD');
      expect(result.normalisedData.kin).toBe('12345678901234');
      expect(client.download).toHaveBeenCalledWith('12345678901234');
    });
  });

  describe('fetchResult — fresh upload path (search misses)', () => {
    it('uploads fresh KYC data and returns the new KIN', async () => {
      const client = makeMockClient({
        search: jest.fn().mockResolvedValue({ found: false }),
        upload: jest.fn().mockResolvedValue({ success: true, kin: '98765432109876' }),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      const result = await adapter.fetchResult(vendorReferenceId);
      expect(result.success).toBe(true);
      expect(result.normalisedData.source).toBe('CKYC_FRESH_UPLOAD');
      expect(result.normalisedData.kin).toBe('98765432109876');
    });

    it('rejects when upload succeeds but returns a malformed KIN', async () => {
      const client = makeMockClient({
        search: jest.fn().mockResolvedValue({ found: false }),
        upload: jest.fn().mockResolvedValue({ success: true, kin: 'not-14-digits' }),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      await expect(adapter.fetchResult(vendorReferenceId)).rejects.toMatchObject({
        vendorErrorCode: 'malformed-kin',
      });
    });

    it('surfaces upload failure with the vendor error code', async () => {
      const client = makeMockClient({
        search: jest.fn().mockResolvedValue({ found: false }),
        upload: jest
          .fn()
          .mockResolvedValue({ success: false, errorCode: 'schema-validation-failure' }),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      await expect(adapter.fetchResult(vendorReferenceId)).rejects.toMatchObject({
        category: InternalErrorCategory.VALIDATION_ERROR,
        vendorErrorCode: 'schema-validation-failure',
      });
    });
  });

  describe('error code mapping — each documented category', () => {
    it('maps record-not-found to NOT_FOUND, non-retryable, and does not itself throw on search', async () => {
      // record-not-found from search() would be modeled as found:false, not an
      // exception — this test covers the case where download() itself 404s
      // after a search race (record deleted between search and download).
      const client = makeMockClient({
        search: jest.fn().mockResolvedValue({ found: true, kin: '11111111111111' }),
        download: jest.fn().mockRejectedValue({ code: 'record-not-found' }),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      await expect(adapter.fetchResult(vendorReferenceId)).rejects.toMatchObject({
        category: InternalErrorCategory.NOT_FOUND,
        retryable: false,
      });
    });

    it('maps duplicate-upload to CONFLICT, non-retryable', async () => {
      const client = makeMockClient({
        search: jest.fn().mockResolvedValue({ found: false }),
        upload: jest.fn().mockRejectedValue({ code: 'duplicate-upload' }),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      await expect(adapter.fetchResult(vendorReferenceId)).rejects.toMatchObject({
        category: InternalErrorCategory.CONFLICT,
        retryable: false,
      });
    });

    it('maps timeout to VENDOR_ERROR, retryable, and recovers on retry', async () => {
      const client = makeMockClient({
        search: jest
          .fn()
          .mockRejectedValueOnce({ code: 'timeout' })
          .mockResolvedValueOnce({ found: false }),
        upload: jest.fn().mockResolvedValue({ success: true, kin: '22222222222222' }),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      const result = await adapter.fetchResult(vendorReferenceId);
      expect(result.success).toBe(true);
      expect(client.search).toHaveBeenCalledTimes(2);
    });

    it('maps schema-validation-failure to VALIDATION_ERROR, non-retryable', async () => {
      const client = makeMockClient({
        search: jest.fn().mockRejectedValue({ code: 'schema-validation-failure' }),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      await expect(adapter.fetchResult(vendorReferenceId)).rejects.toMatchObject({
        category: InternalErrorCategory.VALIDATION_ERROR,
        retryable: false,
      });
      expect(client.search).toHaveBeenCalledTimes(1); // never retried
    });

    it('falls back to VENDOR_ERROR for unmapped codes', async () => {
      const client = makeMockClient({
        search: jest.fn().mockRejectedValue({ code: 'totally-unknown-code' }),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      await expect(adapter.fetchResult(vendorReferenceId)).rejects.toMatchObject({
        category: InternalErrorCategory.VENDOR_ERROR,
      });
    });
  });

  describe('timeout and retry handling', () => {
    it('exhausts retries and surfaces the final error', async () => {
      const client = makeMockClient({
        search: jest.fn().mockRejectedValue({ code: 'timeout' }),
      });
      const adapter = makeAdapter(client);
      const { vendorReferenceId } = await adapter.initiateVerification(baseContext as any);
      await expect(adapter.fetchResult(vendorReferenceId)).rejects.toMatchObject({
        vendorErrorCode: 'timeout',
      });
      expect(client.search).toHaveBeenCalledTimes(3); // initial + 2 retries per FAST_RETRY
    });
  });

  describe('batch upload', () => {
    it('uploads a batch and reports per-record success/failure', async () => {
      const client = makeMockClient({
        uploadBatch: jest.fn().mockResolvedValue({
          batchId: 'batch-001',
          results: [
            { customerId: 'c1', success: true, kin: '33333333333333' },
            { customerId: 'c2', success: false, errorCode: 'schema-validation-failure' },
          ],
        }),
      });
      const adapter = makeAdapter(client);
      const result = await adapter.uploadBatch([
        {
          customerId: 'c1',
          name: 'A',
          dateOfBirth: '1990-01-01',
          address: 'X',
          panNumber: 'P1',
          documents: [],
        },
        {
          customerId: 'c2',
          name: 'B',
          dateOfBirth: '1990-01-01',
          address: 'Y',
          panNumber: 'P2',
          documents: [],
        },
      ]);
      expect(result.succeeded).toEqual(['c1']);
      expect(result.failed).toEqual([{ customerId: 'c2', errorCode: 'schema-validation-failure' }]);
    });

    it('rejects a batch exceeding 1000 records without calling the vendor', async () => {
      const client = makeMockClient();
      const adapter = makeAdapter(client);
      const oversized = Array.from({ length: 1001 }, (_, i) => ({
        customerId: `c${i}`,
        name: 'X',
        dateOfBirth: '1990-01-01',
        address: 'Y',
        panNumber: 'P',
        documents: [],
      }));
      await expect(adapter.uploadBatch(oversized)).rejects.toMatchObject({
        category: InternalErrorCategory.VALIDATION_ERROR,
      });
      expect(client.uploadBatch).not.toHaveBeenCalled();
    });

    it('rejects an empty batch', async () => {
      const adapter = makeAdapter(makeMockClient());
      await expect(adapter.uploadBatch([])).rejects.toMatchObject({
        category: InternalErrorCategory.VALIDATION_ERROR,
      });
    });
  });

  describe('checkStatus', () => {
    it('throws NOT_FOUND for an unknown reference ID', async () => {
      const adapter = makeAdapter(makeMockClient());
      await expect(adapter.checkStatus('nonexistent')).rejects.toMatchObject({
        category: InternalErrorCategory.NOT_FOUND,
      });
    });
  });

  describe('handleCallback — no webhook support', () => {
    it('always returns processed:false since CKYC is pure SOAP request/response', async () => {
      const adapter = makeAdapter(makeMockClient());
      const result = await adapter.handleCallback({} as any);
      expect(result.processed).toBe(false);
    });
  });

  describe('getHealthStatus', () => {
    it('reports unhealthy when the certificate has expired even if circuit is CLOSED', async () => {
      const expiredDate = new Date(Date.now() - 1000);
      const adapter = makeAdapter(makeMockClient(), expiredDate);
      const health = await adapter.getHealthStatus();
      expect(health.isHealthy).toBe(false);
    });

    it('reports healthy when circuit is CLOSED and certificate is valid', async () => {
      const adapter = makeAdapter(makeMockClient());
      const health = await adapter.getHealthStatus();
      expect(health.isHealthy).toBe(true);
    });
  });
});
