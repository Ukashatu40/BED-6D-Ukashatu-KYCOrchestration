// src/infrastructure/vendors/vendor-adapter.factory.spec.ts
import { VendorAdapterFactory } from './vendor-adapter.factory';
import { VendorClientRegistry } from './vendor-client-registry.interface';
import { VendorsYamlConfig } from './vendor-config.schema';
import { InMemoryWebhookDeduplication } from './in-memory-webhook-deduplication';
import { VendorType } from '../../application/ports/kyc-vendor.port';
import { DigilockerAdapter } from './digilocker/digilocker.adapter';
import { CkycAdapter } from './ckyc/ckyc.adapter';
import { VideoKycAdapter } from './video-kyc/video-kyc.adapter';
import { AmlScreeningAdapter } from './aml-screening/aml-screening.adapter';
import { describe, expect, it, beforeAll } from '@jest/globals';

function makeClients(): VendorClientRegistry {
  return {
    digilocker: {
      exchangeAuthCode: jest.fn(),
      refreshAccessToken: jest.fn(),
      revokeToken: jest.fn(),
      fetchDocument: jest.fn(),
      getConsentStatus: jest.fn(),
    },
    ckyc: { search: jest.fn(), download: jest.fn(), upload: jest.fn(), uploadBatch: jest.fn() },
    videoKyc: { createSession: jest.fn(), fetchRecordingUrl: jest.fn() },
    amlScreening: {
      screenRealTime: jest.fn(),
      screenBatch: jest.fn(),
      registerOngoingMonitoring: jest.fn(),
    },
  };
}

const cbBlock = {
  failureThresholdPercent: 50,
  rollingWindowMs: 60000,
  minimumRequestsInWindow: 5,
  openStateTimeoutMs: 30000,
};

function makeConfig(overrides: Partial<VendorsYamlConfig> = {}): VendorsYamlConfig {
  return {
    vendors: [
      {
        vendorType: VendorType.DIGILOCKER,
        enabled: true,
        circuitBreaker: cbBlock,
        credentialsEnvVars: { clientId: 'TEST_DGL_CLIENT_ID' },
        settings: { sandbox: true },
      },
      {
        vendorType: VendorType.CKYC,
        enabled: true,
        circuitBreaker: cbBlock,
        credentialsEnvVars: {},
        settings: { certificateExpiryDate: '2030-01-01T00:00:00.000Z' },
      },
      {
        vendorType: VendorType.VIDEO_KYC,
        enabled: true,
        circuitBreaker: cbBlock,
        credentialsEnvVars: { webhookHmacSecret: 'TEST_VKYC_SECRET' },
        settings: { livenessThreshold: 0.85, faceMatchThreshold: 90, sessionTimeoutSeconds: 3600 },
      },
      {
        vendorType: VendorType.AML_SCREENING,
        enabled: true,
        circuitBreaker: cbBlock,
        credentialsEnvVars: {
          apiKey: 'TEST_AML_KEY',
          requestSigningSecret: 'TEST_AML_KEY',
          webhookHmacSecret: 'TEST_AML_SECRET',
        },
        settings: { fuzzyMatchThreshold: 80 },
      },
    ],
    ...overrides,
  };
}

beforeAll(() => {
  process.env.TEST_DGL_CLIENT_ID = 'dgl-client-id';
  process.env.TEST_VKYC_SECRET = 'vkyc-secret';
  process.env.TEST_AML_KEY = 'aml-key';
  process.env.TEST_AML_SECRET = 'aml-secret';
});

describe('VendorAdapterFactory', () => {
  it('builds a DigilockerAdapter for VendorType.DIGILOCKER', () => {
    const factory = new VendorAdapterFactory(
      makeConfig(),
      makeClients(),
      new InMemoryWebhookDeduplication(),
    );
    expect(factory.getAdapter(VendorType.DIGILOCKER)).toBeInstanceOf(DigilockerAdapter);
  });

  it('builds a CkycAdapter for VendorType.CKYC', () => {
    const factory = new VendorAdapterFactory(
      makeConfig(),
      makeClients(),
      new InMemoryWebhookDeduplication(),
    );
    expect(factory.getAdapter(VendorType.CKYC)).toBeInstanceOf(CkycAdapter);
  });

  it('builds a VideoKycAdapter for VendorType.VIDEO_KYC', () => {
    const factory = new VendorAdapterFactory(
      makeConfig(),
      makeClients(),
      new InMemoryWebhookDeduplication(),
    );
    expect(factory.getAdapter(VendorType.VIDEO_KYC)).toBeInstanceOf(VideoKycAdapter);
  });

  it('builds an AmlScreeningAdapter for VendorType.AML_SCREENING', () => {
    const factory = new VendorAdapterFactory(
      makeConfig(),
      makeClients(),
      new InMemoryWebhookDeduplication(),
    );
    expect(factory.getAdapter(VendorType.AML_SCREENING)).toBeInstanceOf(AmlScreeningAdapter);
  });

  it('returns the same cached instance on repeated calls', () => {
    const factory = new VendorAdapterFactory(
      makeConfig(),
      makeClients(),
      new InMemoryWebhookDeduplication(),
    );
    const first = factory.getAdapter(VendorType.DIGILOCKER);
    const second = factory.getAdapter(VendorType.DIGILOCKER);
    expect(first).toBe(second);
  });

  it('throws when requesting a vendor type with no config entry', () => {
    const factory = new VendorAdapterFactory(
      makeConfig({ vendors: [] }),
      makeClients(),
      new InMemoryWebhookDeduplication(),
    );
    expect(() => factory.getAdapter(VendorType.DIGILOCKER)).toThrow(/No vendors.yml entry/);
  });

  it('throws when the vendor is explicitly disabled', () => {
    const config = makeConfig();
    config.vendors[0].enabled = false;
    const factory = new VendorAdapterFactory(
      config,
      makeClients(),
      new InMemoryWebhookDeduplication(),
    );
    expect(() => factory.getAdapter(VendorType.DIGILOCKER)).toThrow(/disabled/);
  });

  it('reports isEnabled correctly', () => {
    const config = makeConfig();
    config.vendors[1].enabled = false;
    const factory = new VendorAdapterFactory(
      config,
      makeClients(),
      new InMemoryWebhookDeduplication(),
    );
    expect(factory.isEnabled(VendorType.DIGILOCKER)).toBe(true);
    expect(factory.isEnabled(VendorType.CKYC)).toBe(false);
  });

  it('shares one circuit breaker instance per vendor across calls', () => {
    const factory = new VendorAdapterFactory(
      makeConfig(),
      makeClients(),
      new InMemoryWebhookDeduplication(),
    );
    const cb1 = factory.getCircuitBreaker(VendorType.DIGILOCKER);
    const cb2 = factory.getCircuitBreaker(VendorType.DIGILOCKER);
    expect(cb1).toBe(cb2);
  });

  it('gives each vendor an independently configured circuit breaker (different thresholds do not leak across vendors)', () => {
    const config = makeConfig();
    config.vendors[1].circuitBreaker = { ...cbBlock, minimumRequestsInWindow: 2 }; // CKYC tuned lower per ADR-005
    const factory = new VendorAdapterFactory(
      config,
      makeClients(),
      new InMemoryWebhookDeduplication(),
    );
    const dglCb = factory.getCircuitBreaker(VendorType.DIGILOCKER);
    const ckycCb = factory.getCircuitBreaker(VendorType.CKYC);
    expect(dglCb).not.toBe(ckycCb);
  });
});
