// src/application/workflow-engine/guard-expression.evaluator.spec.ts
import { evaluateGuardExpression } from './guard-expression.evaluator';
import { describe, expect, it } from '@jest/globals';

describe('evaluateGuardExpression', () => {
  it('returns true when there is no expression', () => {
    expect(evaluateGuardExpression(null, {})).toBe(true);
    expect(evaluateGuardExpression(undefined, {})).toBe(true);
  });

  it('evaluates a plain flag lookup', () => {
    expect(evaluateGuardExpression('complianceApproved', { complianceApproved: true })).toBe(true);
    expect(evaluateGuardExpression('complianceApproved', { complianceApproved: false })).toBe(
      false,
    );
  });

  it('evaluates a negated flag lookup', () => {
    expect(evaluateGuardExpression('!ckycRecordFound', { ckycRecordFound: true })).toBe(false);
    expect(evaluateGuardExpression('!ckycRecordFound', { ckycRecordFound: false })).toBe(true);
  });

  it('throws on a reference to an unknown flag', () => {
    expect(() => evaluateGuardExpression('someUnknownFlag', {})).toThrow(/unknown context flag/);
  });

  it('trims whitespace around the expression', () => {
    expect(evaluateGuardExpression('  complianceApproved  ', { complianceApproved: true })).toBe(
      true,
    );
  });
});
