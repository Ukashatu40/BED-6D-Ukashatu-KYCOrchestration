// src/infrastructure/vendors/aml-screening/aml-request-signer.ts
import { createHmac } from 'crypto';

/**
 * Signs outbound requests to GlobalWatch per its "API key + HMAC-SHA256
 * signature" auth model (Section A2.4) — distinct from webhook-verification.util.ts,
 * which verifies signatures GlobalWatch sends *to* us on monitoring alerts.
 */
export function signAmlRequest(payload: string, apiKey: string, secret: string): string {
  return createHmac('sha256', secret).update(`${apiKey}:${payload}`).digest('hex');
}
