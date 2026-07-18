// src/infrastructure/vendors/vendor-config.schema.ts
import { VendorType } from '../../application/ports/kyc-vendor.port';

export interface CircuitBreakerYamlConfig {
  failureThresholdPercent: number;
  rollingWindowMs: number;
  minimumRequestsInWindow: number;
  openStateTimeoutMs: number;
}

export interface VendorYamlEntry {
  vendorType: VendorType;
  enabled: boolean;
  circuitBreaker: CircuitBreakerYamlConfig;
  // Names of env vars holding secrets — never the secret values themselves.
  // Resolved at factory construction time via process.env lookup.
  credentialsEnvVars: Record<string, string>;
  settings: Record<string, unknown>;
}

export interface VendorsYamlConfig {
  vendors: VendorYamlEntry[];
}
