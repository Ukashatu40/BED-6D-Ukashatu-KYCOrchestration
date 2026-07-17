// src/domain/value-objects/risk-score.vo.spec.ts
import { RiskScore } from './risk-score.vo';
import { describe, it, expect } from '@jest/globals';
describe('RiskScore value object', () => {
  it('creates a valid score', () => {
    expect(RiskScore.create(42).getValue()).toBe(42);
  });

  it('rejects a score below 0', () => {
    expect(() => RiskScore.create(-1)).toThrow();
  });

  it('rejects a score above 100', () => {
    expect(() => RiskScore.create(101)).toThrow();
  });

  it('flags scores above the EDD threshold', () => {
    expect(RiskScore.create(61).exceedsEddThreshold()).toBe(true);
    expect(RiskScore.create(60).exceedsEddThreshold()).toBe(false);
  });
});
