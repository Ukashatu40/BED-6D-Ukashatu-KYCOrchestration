// test/contract/kyc-vendor-port.contract.spec.ts
import { DigilockerAdapter } from '../../src/infrastructure/vendors/digilocker/digilocker.adapter';
import { DigilockerHttpClient } from '../../src/infrastructure/vendors/digilocker/digilocker-http-client.interface';
import { CkycAdapter } from '../../src/infrastructure/vendors/ckyc/ckyc.adapter';
import { CkycSoapClient } from '../../src/infrastructure/vendors/ckyc/ckyc-soap-client.interface';
import { VideoKycAdapter } from '../../src/infrastructure/vendors/video-kyc/video-kyc.adapter';
import { VideoKycHttpClient } from '../../src/infrastructure/vendors/video-kyc/video-kyc-http-client.interface';
import { AmlScreeningAdapter } from '../../src/infrastructure/vendors/aml-screening/aml-screening.adapter';
import { AmlScreeningHttpClient } from '../../src/infrastructure/vendors/aml-screening/aml-screening-http-client.interface';
import { CircuitBreaker } from '../../src/infrastructure/vendors/circuit-breaker';
import { InMemoryWebhookDeduplication } from '../../src/infrastructure/vendors/in-memory-webhook-deduplication';
import {
  InternalErrorCategory,
  KycVendorPort,
  VendorType,
  WebhookPayload,
} from '../../src/application/ports/kyc-vendor.port';
import { KycTier } from '../../src/domain/value-objects/kyc-tier.enum';
import { DocumentType } from '../../src/domain/value-objects/document-type.enum';
import { createHmac } from 'crypto';
import { describe, expect, it, beforeEach } from '@jest/globals';

const cbConfig = {
  vendorType: 'CONTRACT_TEST',
  failureThresholdPercent: 50,
  rollingWindowMs: 60_000,
  minimumRequestsInWindow: 100,
  openStateTimeoutMs: 30_000,
};

interface ContractHarness {
  vendorType: VendorType;
  adapter: KycVendorPort;
  /** Runs initiateVerification with mocks configured for a guaranteed happy path, returns the reference ID. */
  seedHappyInitiation: () => Promise<string>;
  /** Returns a WebhookPayload this adapter will accept without throwing (validly signed where applicable). */
  buildAcceptableWebhook: () => WebhookPayload;
}

function buildDigilockerHarness(): ContractHarness {
  const client: DigilockerHttpClient = {
    exchangeAuthCode: jest.fn(),
    refreshAccessToken: jest.fn(),
    revokeToken: jest.fn(),
    fetchDocument: jest.fn(),
    getConsentStatus: jest.fn().mockResolvedValue('GRANTED'),
  };
  const adapter = new DigilockerAdapter(
    client,
    { clientId: 'test', sandbox: true },
    new CircuitBreaker({ ...cbConfig, vendorType: VendorType.DIGILOCKER }),
  );
  return {
    vendorType: VendorType.DIGILOCKER,
    adapter,
    seedHappyInitiation: async () => {
      const result = await adapter.initiateVerification({
        customerId: 'cust-contract',
        requestId: 'req-contract',
        tier: KycTier.MINIMUM,
        documentType: DocumentType.AADHAAR,
        metadata: {},
      });
      return result.vendorReferenceId;
    },
    buildAcceptableWebhook: () => ({
      vendorType: VendorType.DIGILOCKER,
      eventId: 'evt-contract',
      eventType: 'n/a',
      signature: '',
      rawBody: Buffer.from('{}'),
      headers: {},
    }),
  };
}

function buildCkycHarness(): ContractHarness {
  const client: CkycSoapClient = {
    search: jest.fn().mockResolvedValue({ found: true, kin: '12345678901234' }),
    download: jest.fn().mockResolvedValue({
      kin: '12345678901234',
      name: 'Contract Test',
      dateOfBirth: '1990-01-01',
      address: 'Test',
      documents: [],
      lastUpdatedAt: '2026-01-01',
    }),
    upload: jest.fn(),
    uploadBatch: jest.fn(),
  };
  const adapter = new CkycAdapter(
    client,
    { certificateExpiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) },
    new CircuitBreaker({ ...cbConfig, vendorType: VendorType.CKYC }),
  );
  return {
    vendorType: VendorType.CKYC,
    adapter,
    seedHappyInitiation: async () => {
      const result = await adapter.initiateVerification({
        customerId: 'cust-contract',
        requestId: 'req-contract',
        tier: KycTier.FULL,
        metadata: { panNumber: 'ABCDE1234F' },
      });
      return result.vendorReferenceId;
    },
    buildAcceptableWebhook: () => ({
      vendorType: VendorType.CKYC,
      eventId: 'evt-contract',
      eventType: 'n/a',
      signature: '',
      rawBody: Buffer.from('{}'),
      headers: {},
    }),
  };
}

function buildVideoKycHarness(): ContractHarness {
  const secret = 'contract-test-secret';
  const client: VideoKycHttpClient = {
    createSession: jest
      .fn()
      .mockResolvedValue({ sessionId: 'sess-contract', sessionUrl: 'https://x/y' }),
    fetchRecordingUrl: jest.fn(),
  };
  const adapter = new VideoKycAdapter(
    client,
    {
      livenessThreshold: 0.85,
      faceMatchThreshold: 90,
      sessionTimeoutSeconds: 3600,
      webhookHmacSecret: secret,
    },
    new CircuitBreaker({ ...cbConfig, vendorType: VendorType.VIDEO_KYC }),
    new InMemoryWebhookDeduplication(),
  );
  return {
    vendorType: VendorType.VIDEO_KYC,
    adapter,
    seedHappyInitiation: async () => {
      const result = await adapter.initiateVerification({
        customerId: 'cust-contract',
        requestId: 'req-contract',
        tier: KycTier.EDD,
        metadata: {},
      });
      return result.vendorReferenceId;
    },
    buildAcceptableWebhook: () => {
      const rawBody = Buffer.from(
        JSON.stringify({
          eventId: 'evt-contract',
          event: 'session.started',
          sessionId: 'sess-contract',
        }),
      );
      return {
        vendorType: VendorType.VIDEO_KYC,
        eventId: 'evt-contract',
        eventType: 'session.started',
        signature: createHmac('sha256', secret).update(rawBody).digest('hex'),
        rawBody,
        headers: {},
      };
    },
  };
}

function buildAmlScreeningHarness(): ContractHarness {
  const webhookSecret = 'contract-test-webhook-secret';
  const client: AmlScreeningHttpClient = {
    screenRealTime: jest.fn().mockResolvedValue({
      vendorScreeningId: 'scr-contract',
      matchCount: 0,
      matches: [],
      highestRiskScore: 0,
      highestConfidence: 0,
    }),
    screenBatch: jest.fn(),
    registerOngoingMonitoring: jest.fn(),
  };
  const adapter = new AmlScreeningAdapter(
    client,
    {
      apiKey: 'k',
      requestSigningSecret: 's',
      webhookHmacSecret: webhookSecret,
      fuzzyMatchThreshold: 80,
    },
    new CircuitBreaker({ ...cbConfig, vendorType: VendorType.AML_SCREENING }),
    new InMemoryWebhookDeduplication(),
  );
  return {
    vendorType: VendorType.AML_SCREENING,
    adapter,
    seedHappyInitiation: async () => {
      const result = await adapter.initiateVerification({
        customerId: 'cust-contract',
        requestId: 'req-contract',
        tier: KycTier.FULL,
        metadata: { fullName: 'Contract Test', dateOfBirth: '1990-01-01' },
      });
      return result.vendorReferenceId;
    },
    buildAcceptableWebhook: () => {
      const rawBody = Buffer.from(
        JSON.stringify({
          eventId: 'evt-contract',
          event: 'monitoring.list_updated',
          customerId: 'cust-contract',
        }),
      );
      return {
        vendorType: VendorType.AML_SCREENING,
        eventId: 'evt-contract',
        eventType: 'monitoring.list_updated',
        signature: createHmac('sha256', webhookSecret).update(rawBody).digest('hex'),
        rawBody,
        headers: {},
      };
    },
  };
}

const harnessBuilders: Array<[string, () => ContractHarness]> = [
  ['DigilockerAdapter', buildDigilockerHarness],
  ['CkycAdapter', buildCkycHarness],
  ['VideoKycAdapter', buildVideoKycHarness],
  ['AmlScreeningAdapter', buildAmlScreeningHarness],
];

describe('KycVendorPort contract — all four adapters', () => {
  describe.each(harnessBuilders)('%s', (_name, buildHarness) => {
    let harness: ContractHarness;

    beforeEach(() => {
      harness = buildHarness();
    });

    it('initiateVerification returns a VendorInitiationResult with a non-empty string reference ID and boolean isAsync', async () => {
      const referenceId = await harness.seedHappyInitiation();
      expect(typeof referenceId).toBe('string');
      expect(referenceId.length).toBeGreaterThan(0);
    });

    it('checkStatus rejects with NOT_FOUND for an unrecognised reference ID', async () => {
      await expect(harness.adapter.checkStatus('contract-test-unknown-ref')).rejects.toMatchObject({
        category: InternalErrorCategory.NOT_FOUND,
      });
    });

    it('checkStatus resolves to a VendorStatusResult with vendorReferenceId and a valid status enum value', async () => {
      const referenceId = await harness.seedHappyInitiation();
      const status = await harness.adapter.checkStatus(referenceId);
      expect(status.vendorReferenceId).toBe(referenceId);
      expect(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED']).toContain(status.status);
    });

    it('handleCallback resolves to a CallbackProcessingResult with boolean processed and wasDuplicate fields', async () => {
      const payload = harness.buildAcceptableWebhook();
      const result = await harness.adapter.handleCallback(payload);
      expect(typeof result.processed).toBe('boolean');
      expect(typeof result.wasDuplicate).toBe('boolean');
    });

    it('getHealthStatus resolves to a VendorHealthStatus whose vendorType matches the adapter and whose circuitBreakerState is a valid enum value', async () => {
      const health = await harness.adapter.getHealthStatus();
      expect(health.vendorType).toBe(harness.vendorType);
      expect(typeof health.isHealthy).toBe('boolean');
      expect(['CLOSED', 'OPEN', 'HALF_OPEN']).toContain(health.circuitBreakerState);
    });

    it('getHealthStatus reports healthy immediately after construction (fresh circuit breaker starts CLOSED)', async () => {
      const health = await harness.adapter.getHealthStatus();
      expect(health.circuitBreakerState).toBe('CLOSED');
      expect(health.isHealthy).toBe(true);
    });
  });

  describe('cross-adapter consistency', () => {
    it('all four adapters implement every KycVendorPort method', () => {
      const requiredMethods: Array<keyof KycVendorPort> = [
        'initiateVerification',
        'checkStatus',
        'fetchResult',
        'handleCallback',
        'getHealthStatus',
      ];
      for (const [name, buildHarness] of harnessBuilders) {
        const { adapter } = buildHarness();
        for (const method of requiredMethods) {
          expect(typeof adapter[method]).toBe(`function`);
        }
      }
    });

    it('all four adapters report a distinct, correct vendorType in getHealthStatus', async () => {
      const seen = new Set<VendorType>();
      for (const [, buildHarness] of harnessBuilders) {
        const { adapter, vendorType } = buildHarness();
        const health = await adapter.getHealthStatus();
        expect(health.vendorType).toBe(vendorType);
        seen.add(health.vendorType);
      }
      expect(seen.size).toBe(4); // no two adapters report the same vendorType
    });

    it('all four adapters reject checkStatus on an unknown reference with the same InternalErrorCategory', async () => {
      for (const [, buildHarness] of harnessBuilders) {
        const { adapter } = buildHarness();
        await expect(adapter.checkStatus('unknown-ref')).rejects.toMatchObject({
          category: InternalErrorCategory.NOT_FOUND,
        });
      }
    });
  });
});
