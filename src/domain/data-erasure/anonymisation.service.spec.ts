// src/infrastructure/data-erasure/anonymisation.service.spec.ts
import { AnonymisationService } from './anonymisation.service';
import { it, expect, describe } from '@jest/globals';

describe('AnonymisationService', () => {
  it('produces a 32-byte SHA-256 digest', () => {
    const service = new AnonymisationService();
    expect(service.anonymiseValue().length).toBe(32);
  });

  it('produces a different value on every call (never deterministic/reversible)', () => {
    const service = new AnonymisationService();
    const a = service.anonymiseValue();
    const b = service.anonymiseValue();
    expect(a.equals(b)).toBe(false);
  });
});
