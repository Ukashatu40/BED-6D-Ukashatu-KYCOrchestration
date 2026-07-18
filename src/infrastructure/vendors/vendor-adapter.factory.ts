import { KycVendorPort, VendorType } from '../../application/ports/kyc-vendor.port';
import { WebhookDeduplicationPort } from '../../application/ports/webhook-deduplication.port';
import { CircuitBreaker } from './circuit-breaker';
import { VendorClientRegistry } from './vendor-client-registry.interface';
import { VendorYamlEntry, VendorsYamlConfig } from './vendor-config.schema';
import { resolveCredentials } from './vendor-config.loader';
import { DigilockerAdapter } from './digilocker/digilocker.adapter';
import { CkycAdapter } from './ckyc/ckyc.adapter';
import { VideoKycAdapter } from './video-kyc/video-kyc.adapter';
import { AmlScreeningAdapter } from './aml-screening/aml-screening.adapter';

/**
 * Instantiates the correct KycVendorPort adapter for a given VendorType,
 * entirely driven by vendors.yml. Per ADR-002/C1.2 (the Aadhaar-eKYC
 * transition case study): swapping a vendor means editing this file and
 * one credentials env var — zero changes to this factory or the
 * orchestration engine that consumes it.
 */
export class VendorAdapterFactory {
  private readonly entriesByType: Map<VendorType, VendorYamlEntry>;
  private readonly circuitBreakers: Map<VendorType, CircuitBreaker> = new Map();
  private readonly adapters: Map<VendorType, KycVendorPort> = new Map();

  constructor(
    private readonly config: VendorsYamlConfig,
    private readonly clients: VendorClientRegistry,
    private readonly dedup: WebhookDeduplicationPort,
  ) {
    this.entriesByType = new Map(this.config.vendors.map((entry) => [entry.vendorType, entry]));
  }

  /** Lazily builds and caches one adapter instance per vendor type — adapters hold session state, so identity matters. */
  getAdapter(vendorType: VendorType): KycVendorPort {
    const cached = this.adapters.get(vendorType);
    if (cached) return cached;

    const entry = this.entriesByType.get(vendorType);
    if (!entry) {
      throw new Error(`No vendors.yml entry found for vendor type ${vendorType}`);
    }
    if (!entry.enabled) {
      throw new Error(`Vendor ${vendorType} is disabled in vendors.yml`);
    }

    const circuitBreaker = this.getOrCreateCircuitBreaker(entry);
    const adapter = this.buildAdapter(entry, circuitBreaker);
    this.adapters.set(vendorType, adapter);
    return adapter;
  }

  getCircuitBreaker(vendorType: VendorType): CircuitBreaker {
    const entry = this.entriesByType.get(vendorType);
    if (!entry) {
      throw new Error(`No vendors.yml entry found for vendor type ${vendorType}`);
    }
    return this.getOrCreateCircuitBreaker(entry);
  }

  isEnabled(vendorType: VendorType): boolean {
    return this.entriesByType.get(vendorType)?.enabled ?? false;
  }

  private getOrCreateCircuitBreaker(entry: VendorYamlEntry): CircuitBreaker {
    const cached = this.circuitBreakers.get(entry.vendorType);
    if (cached) return cached;
    const cb = new CircuitBreaker({
      vendorType: entry.vendorType,
      failureThresholdPercent: entry.circuitBreaker.failureThresholdPercent,
      rollingWindowMs: entry.circuitBreaker.rollingWindowMs,
      minimumRequestsInWindow: entry.circuitBreaker.minimumRequestsInWindow,
      openStateTimeoutMs: entry.circuitBreaker.openStateTimeoutMs,
    });
    this.circuitBreakers.set(entry.vendorType, cb);
    return cb;
  }

  private buildAdapter(entry: VendorYamlEntry, circuitBreaker: CircuitBreaker): KycVendorPort {
    const credentials = resolveCredentials(
      entry.credentialsEnvVars,
      entry.enabled,
      entry.vendorType,
    );

    switch (entry.vendorType) {
      case VendorType.DIGILOCKER:
        return new DigilockerAdapter(
          this.clients.digilocker,
          { clientId: credentials.clientId, sandbox: Boolean(entry.settings.sandbox) },
          circuitBreaker,
        );

      case VendorType.CKYC:
        return new CkycAdapter(
          this.clients.ckyc,
          { certificateExpiryDate: new Date(String(entry.settings.certificateExpiryDate)) },
          circuitBreaker,
        );

      case VendorType.VIDEO_KYC:
        return new VideoKycAdapter(
          this.clients.videoKyc,
          {
            livenessThreshold: Number(entry.settings.livenessThreshold),
            faceMatchThreshold: Number(entry.settings.faceMatchThreshold),
            sessionTimeoutSeconds: Number(entry.settings.sessionTimeoutSeconds),
            webhookHmacSecret: credentials.webhookHmacSecret,
          },
          circuitBreaker,
          this.dedup,
        );

      case VendorType.AML_SCREENING:
        return new AmlScreeningAdapter(
          this.clients.amlScreening,
          {
            apiKey: credentials.apiKey,
            requestSigningSecret: credentials.requestSigningSecret,
            webhookHmacSecret: credentials.webhookHmacSecret,
            fuzzyMatchThreshold: Number(entry.settings.fuzzyMatchThreshold),
          },
          circuitBreaker,
          this.dedup,
        );

      default: {
        const exhaustiveCheck: never = entry.vendorType;
        throw new Error(`Unhandled vendor type in factory: ${exhaustiveCheck}`);
      }
    }
  }
}
