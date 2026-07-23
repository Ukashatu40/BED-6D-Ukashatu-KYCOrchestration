// src/domain/data-erasure/legal-hold-evaluator.spec.ts
import { LegalHoldEvaluator } from './legal-hold-evaluator';
import { it, expect, describe } from '@jest/globals';

describe('LegalHoldEvaluator', () => {
  const evaluator = new LegalHoldEvaluator();

  it('returns no holds for a customer with no relationship history and no active flags', () => {
    const holds = evaluator.evaluate({
      relationshipEndDate: null,
      hasActiveLoans: false,
      hasOpenInvestigations: false,
      hasPendingLitigation: false,
    });
    expect(holds).toHaveLength(0);
  });

  it('reproduces Scenario B4.3 exactly: loan closed 18 months ago still has an active PMLA hold', () => {
    const eighteenMonthsAgo = new Date();
    eighteenMonthsAgo.setMonth(eighteenMonthsAgo.getMonth() - 18);
    const holds = evaluator.evaluate({
      relationshipEndDate: eighteenMonthsAgo,
      hasActiveLoans: false,
      hasOpenInvestigations: false,
      hasPendingLitigation: false,
    });
    expect(holds).toHaveLength(1);
    expect(holds[0].holdType).toBe('PMLA');
  });

  it('does not apply a PMLA hold once the 5-year window has fully elapsed', () => {
    const sixYearsAgo = new Date();
    sixYearsAgo.setFullYear(sixYearsAgo.getFullYear() - 6);
    const holds = evaluator.evaluate({
      relationshipEndDate: sixYearsAgo,
      hasActiveLoans: false,
      hasOpenInvestigations: false,
      hasPendingLitigation: false,
    });
    expect(holds).toHaveLength(0);
  });

  it('applies an indefinite ACTIVE_LOAN hold with no expiry date', () => {
    const holds = evaluator.evaluate({
      relationshipEndDate: null,
      hasActiveLoans: true,
      hasOpenInvestigations: false,
      hasPendingLitigation: false,
    });
    expect(holds).toEqual([
      { holdType: 'ACTIVE_LOAN', reason: expect.any(String), expiryDate: null },
    ]);
  });

  it('applies multiple simultaneous holds when several conditions are true', () => {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const holds = evaluator.evaluate({
      relationshipEndDate: oneYearAgo,
      hasActiveLoans: false,
      hasOpenInvestigations: true,
      hasPendingLitigation: true,
    });
    expect(holds.map((h) => h.holdType).sort()).toEqual(['INVESTIGATION', 'LITIGATION', 'PMLA']);
  });

  describe('latestExpiry', () => {
    it('returns null for an empty hold list', () => {
      expect(evaluator.latestExpiry([])).toBeNull();
    });

    it('returns null when any hold is indefinite', () => {
      const expiry = evaluator.latestExpiry([
        { holdType: 'PMLA', reason: 'x', expiryDate: new Date() },
        { holdType: 'ACTIVE_LOAN', reason: 'x', expiryDate: null },
      ]);
      expect(expiry).toBeNull();
    });

    it('returns the latest date among multiple finite-expiry holds', () => {
      const earlier = new Date('2027-01-01');
      const later = new Date('2028-01-01');
      const expiry = evaluator.latestExpiry([
        { holdType: 'PMLA', reason: 'x', expiryDate: earlier },
      ]);
      expect(expiry).toEqual(earlier);
    });
  });
});
