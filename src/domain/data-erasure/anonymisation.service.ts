// src/infrastructure/data-erasure/anonymisation.service.ts
import { createHash, randomBytes } from 'crypto';

/**
 * Produces irreversible anonymised replacements — SHA-256 of fresh random
 * bytes, never the original value or any deterministic function of it.
 * "Irreversible" here specifically means: given only the output, there is
 * no way to recover or even narrow down the original plaintext, matching
 * Section A1.3(a)'s "replace phone/email with irreversible tokens"
 * requirement (as distinct from encryption, which IS reversible given the
 * key — anonymisation must not be).
 */
export class AnonymisationService {
  anonymiseValue(): Buffer {
    return createHash('sha256').update(randomBytes(32)).digest();
  }
}
