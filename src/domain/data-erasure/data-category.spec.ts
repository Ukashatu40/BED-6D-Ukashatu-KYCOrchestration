// src/domain/data-erasure/data-category.spec.ts
import { categoriseDataForErasure, DataCategory } from './data-category';
import { it, expect, describe } from '@jest/globals';

describe('categoriseDataForErasure', () => {
  it('marks only the always-eligible categories when a hold is active', () => {
    const result = categoriseDataForErasure([
      { holdType: 'PMLA', reason: 'x', expiryDate: new Date() },
    ]);
    expect(result.eligibleForErasure).toEqual([
      DataCategory.MARKETING_PREFERENCES,
      DataCategory.COMMUNICATION_HISTORY,
      DataCategory.BEHAVIOURAL_DATA,
      DataCategory.SUPPLEMENTARY_DOCUMENTS,
    ]);
    expect(result.retainedUnderHold).toContain(DataCategory.KYC_DOCUMENTS);
    expect(result.retainedUnderHold).toContain(DataCategory.CORE_IDENTITY_PII);
  });

  it('marks everything eligible when there are no holds at all (full erasure)', () => {
    const result = categoriseDataForErasure([]);
    expect(result.eligibleForErasure).toContain(DataCategory.KYC_DOCUMENTS);
    expect(result.eligibleForErasure).toContain(DataCategory.CORE_IDENTITY_PII);
    expect(result.retainedUnderHold).toHaveLength(0);
  });
});
