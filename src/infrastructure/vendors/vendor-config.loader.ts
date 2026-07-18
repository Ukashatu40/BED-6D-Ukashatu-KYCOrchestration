// src/infrastructure/vendors/vendor-config.loader.ts
import { readFileSync } from 'fs';
import { load } from 'js-yaml';
import { VendorsYamlConfig } from './vendor-config.schema';

/**
 * Loads and validates vendors.yml. Deliberately fails loudly and early
 * (at startup, not at first vendor call) on a malformed config — a bad
 * YAML entry should never surface as a mysterious runtime error deep in
 * an adapter three requests into production traffic.
 */
export function loadVendorsConfig(filePath: string): VendorsYamlConfig {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = load(raw) as VendorsYamlConfig;

  if (!parsed || !Array.isArray(parsed.vendors)) {
    throw new Error(`Invalid vendors config at ${filePath}: missing top-level "vendors" array`);
  }

  for (const entry of parsed.vendors) {
    if (!entry.vendorType) {
      throw new Error(`Invalid vendors config: entry missing "vendorType"`);
    }
    if (!entry.circuitBreaker) {
      throw new Error(
        `Invalid vendors config for ${entry.vendorType}: missing "circuitBreaker" block`,
      );
    }
    const cb = entry.circuitBreaker;
    if (
      typeof cb.failureThresholdPercent !== 'number' ||
      typeof cb.rollingWindowMs !== 'number' ||
      typeof cb.minimumRequestsInWindow !== 'number' ||
      typeof cb.openStateTimeoutMs !== 'number'
    ) {
      throw new Error(
        `Invalid circuitBreaker config for ${entry.vendorType}: all fields must be numbers`,
      );
    }
  }

  return parsed;
}

/**
 * Resolves credential env var *names* (from YAML) into their actual values
 * from process.env. Throws if a required var is unset and the vendor is
 * enabled — an enabled vendor with missing credentials should fail startup,
 * not fail confusingly on the first real request.
 */
export function resolveCredentials(
  credentialsEnvVars: Record<string, string>,
  enabled: boolean,
  vendorType: string,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, envVarName] of Object.entries(credentialsEnvVars)) {
    const value = process.env[envVarName];
    if (enabled && !value) {
      throw new Error(
        `Missing required environment variable "${envVarName}" for enabled vendor ${vendorType} (config key "${key}")`,
      );
    }
    resolved[key] = value ?? '';
  }
  return resolved;
}
