// src/infrastructure/vendors/webhook-verification.util.ts
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verifies an HMAC-SHA256 webhook signature using constant-time comparison
 * (timingSafeEqual) to avoid timing side-channel attacks on the signature
 * check — required by the spec's HMAC verification security checklist item.
 */
export function verifyHmacSignature(
  rawBody: Buffer,
  providedSignatureHex: string,
  secret: string,
): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(providedSignatureHex, 'hex');

  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, providedBuf);
}
