// test/integration/scenarios/b4-1-vendor-outage.spec.ts
import { DigilockerAdapter } from '../../../src/infrastructure/vendors/digilocker/digilocker.adapter';
import { DigilockerHttpClient } from '../../../src/infrastructure/vendors/digilocker/digilocker-http-client.interface';
import { CircuitBreaker } from '../../../src/infrastructure/vendors/circuit-breaker';
import { VendorType, InternalErrorCategory } from '../../../src/application/ports/kyc-vendor.port';
import { KycTier } from '../../../src/domain/value-objects/kyc-tier.enum';
import { DocumentType } from '../../../src/domain/value-objects/document-type.enum';
import { describe, it, expect } from '@jest/globals';
import { RetryPolicy } from '../../../src/infrastructure/vendors/retry.util';

const FAST_RETRY: RetryPolicy = {
  maxRetries: 1, // keep this LOW — the scenario needs 5 initiate+fetch cycles to trip the breaker; each retry compounds real wait time even at "fast" ms-scale
  initialDelayMs: 1,
  backoffMultiplier: 2,
  maxDelayMs: 4,
  jitterMaxMs: 1,
};
/**
 * Models Section B4.1: a 4-hour Digilocker outage during peak hours,
 * 2,400 customers mid-onboarding. What's exercised: (a) detection via
 * consecutive failures, (b) circuit breaker transitioning CLOSED -> OPEN,
 * (c) subsequent requests short-circuited rather than hitting a dead
 * vendor, (d) health check correctly reporting the degraded state, (e)
 * automatic recovery via HALF_OPEN probe once the vendor comes back.
 *
 * NOT exercised here (flagged, not silently passed over): the spec's (c)
 * "route to alternative path (manual Aadhaar upload with OCR)" fallback
 * adapter does not exist yet — that's a genuinely separate component
 * (an OCR-backed fallback KycVendorPort implementation) this project's
 * timeline hasn't reached. What IS proven: the circuit breaker correctly
 * protects the system from hammering a dead vendor and surfaces a clean,
 * typed VENDOR_UNAVAILABLE error the orchestration layer can act on —
 * the foundation a fallback path would be built on top of.
 */
describe('Scenario B4.1 — Vendor Outage (Digilocker)', () => {
  function makeAdapter(client: DigilockerHttpClient) {
    const circuitBreaker = new CircuitBreaker({
      vendorType: VendorType.DIGILOCKER,
      failureThresholdPercent: 50,
      rollingWindowMs: 60_000,
      minimumRequestsInWindow: 5,
      openStateTimeoutMs: 50,
    });
    return {
      adapter: new DigilockerAdapter(
        client,
        { clientId: 'test', sandbox: true },
        circuitBreaker,
        FAST_RETRY, // 4th arg — was missing, causing production-speed retries
      ),
      circuitBreaker,
    };
  }
  const context = {
    customerId: 'cust-001',
    requestId: 'req-001',
    tier: KycTier.MINIMUM,
    documentType: DocumentType.AADHAAR,
    metadata: {},
  };

  it('detects the outage and opens the circuit after sustained failures', async () => {
    const client: DigilockerHttpClient = {
      exchangeAuthCode: jest.fn(),
      refreshAccessToken: jest.fn(),
      revokeToken: jest.fn(),
      fetchDocument: jest.fn().mockRejectedValue({ code: 'service-unavailable' }),
      getConsentStatus: jest.fn(),
    };
    const { adapter, circuitBreaker } = makeAdapter(client);

    for (let i = 0; i < 5; i++) {
      const { vendorReferenceId } = await adapter.initiateVerification(context);
      await adapter.fetchResult(vendorReferenceId).catch(() => {});
    }

    expect(circuitBreaker.getState()).toBe('OPEN');
  });

  it('short-circuits subsequent requests once open, without hitting the dead vendor again', async () => {
    const fetchDocument = jest.fn().mockRejectedValue({ code: 'service-unavailable' });
    const client: DigilockerHttpClient = {
      exchangeAuthCode: jest.fn(),
      refreshAccessToken: jest.fn(),
      revokeToken: jest.fn(),
      fetchDocument,
      getConsentStatus: jest.fn(),
    };
    const { adapter } = makeAdapter(client);

    for (let i = 0; i < 5; i++) {
      const { vendorReferenceId } = await adapter.initiateVerification(context);
      await adapter.fetchResult(vendorReferenceId).catch(() => {});
    }
    const callsBeforeOpen = fetchDocument.mock.calls.length;

    const { vendorReferenceId } = await adapter.initiateVerification(context);
    await expect(adapter.fetchResult(vendorReferenceId)).rejects.toThrow(/Circuit breaker OPEN/);
    expect(fetchDocument.mock.calls.length).toBe(callsBeforeOpen); // vendor never actually called again
  });

  it('reports DEGRADED health status while the circuit is open', async () => {
    const client: DigilockerHttpClient = {
      exchangeAuthCode: jest.fn(),
      refreshAccessToken: jest.fn(),
      revokeToken: jest.fn(),
      fetchDocument: jest.fn().mockRejectedValue({ code: 'service-unavailable' }),
      getConsentStatus: jest.fn(),
    };
    const { adapter } = makeAdapter(client);
    for (let i = 0; i < 5; i++) {
      const { vendorReferenceId } = await adapter.initiateVerification(context);
      await adapter.fetchResult(vendorReferenceId).catch(() => {});
    }
    const health = await adapter.getHealthStatus();
    expect(health.isHealthy).toBe(false);
    expect(health.circuitBreakerState).toBe('OPEN');
  });

  it('every failure is normalised to VENDOR_UNAVAILABLE, never leaking a raw vendor error to the caller', async () => {
    const client: DigilockerHttpClient = {
      exchangeAuthCode: jest.fn(),
      refreshAccessToken: jest.fn(),
      revokeToken: jest.fn(),
      fetchDocument: jest.fn().mockRejectedValue({ code: 'service-unavailable' }),
      getConsentStatus: jest.fn(),
    };
    const { adapter } = makeAdapter(client);
    const { vendorReferenceId } = await adapter.initiateVerification(context);
    await expect(adapter.fetchResult(vendorReferenceId)).rejects.toMatchObject({
      category: InternalErrorCategory.VENDOR_UNAVAILABLE,
    });
  });

  it('recovers automatically: half-open probe succeeds once the vendor comes back, resuming normal service', async () => {
    let outageActive = true;
    const client: DigilockerHttpClient = {
      exchangeAuthCode: jest.fn(),
      refreshAccessToken: jest.fn(),
      revokeToken: jest.fn(),
      fetchDocument: jest.fn(async () => {
        if (outageActive) throw { code: 'service-unavailable' };
        return {
          documentType: DocumentType.AADHAAR,
          base64Content: 'x',
          pkcs7Signature: 'valid-sig',
          extractedFields: { name: 'Test', dateOfBirth: '1990-01-01', documentNumber: '123' },
        };
      }),
      getConsentStatus: jest.fn(),
    };
    const { adapter, circuitBreaker } = makeAdapter(client);

    for (let i = 0; i < 5; i++) {
      const { vendorReferenceId } = await adapter.initiateVerification(context);
      await adapter.fetchResult(vendorReferenceId).catch(() => {});
    }
    expect(circuitBreaker.getState()).toBe('OPEN');

    outageActive = false; // vendor recovers
    await new Promise((resolve) => setTimeout(resolve, 60)); // exceed openStateTimeoutMs
    expect(circuitBreaker.getState()).toBe('HALF_OPEN');

    const { vendorReferenceId } = await adapter.initiateVerification(context);
    const result = await adapter.fetchResult(vendorReferenceId);
    expect(result.success).toBe(true);
    expect(circuitBreaker.getState()).toBe('CLOSED');
  });
});
