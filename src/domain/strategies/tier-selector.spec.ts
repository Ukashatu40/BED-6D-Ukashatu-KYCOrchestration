// src/domain/strategies/tier-selector.spec.ts
import { TierSelector } from './tier-selector';
import { KycTier } from '../value-objects/kyc-tier.enum';
import { expect, it, describe } from '@jest/globals';

describe('TierSelector', () => {
  const selector = new TierSelector();

  it('selects MINIMUM for a small instant loan with no risk flags', () => {
    expect(
      selector.selectTier({ loanAmountInr: 30_000, isPep: false, isHighRiskJurisdiction: false }),
    ).toBe(KycTier.MINIMUM);
  });

  it('selects FULL for a standard loan amount with no risk flags', () => {
    expect(
      selector.selectTier({ loanAmountInr: 500_000, isPep: false, isHighRiskJurisdiction: false }),
    ).toBe(KycTier.FULL);
  });

  it('selects EDD for a PEP regardless of loan amount', () => {
    expect(
      selector.selectTier({ loanAmountInr: 30_000, isPep: true, isHighRiskJurisdiction: false }),
    ).toBe(KycTier.EDD);
  });

  it('selects EDD for a high-risk jurisdiction regardless of loan amount', () => {
    expect(
      selector.selectTier({ loanAmountInr: 30_000, isPep: false, isHighRiskJurisdiction: true }),
    ).toBe(KycTier.EDD);
  });

  it('selects EDD for a loan exceeding INR 50 lakh', () => {
    expect(
      selector.selectTier({
        loanAmountInr: 5_000_001,
        isPep: false,
        isHighRiskJurisdiction: false,
      }),
    ).toBe(KycTier.EDD);
  });

  it('selects FULL at exactly the MINIMUM/FULL boundary (50,000)', () => {
    expect(
      selector.selectTier({ loanAmountInr: 50_000, isPep: false, isHighRiskJurisdiction: false }),
    ).toBe(KycTier.FULL);
  });
});
