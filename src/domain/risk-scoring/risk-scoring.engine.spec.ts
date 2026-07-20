// src/domain/risk-scoring/risk-scoring.engine.spec.ts
import { RiskScoringEngine } from './risk-scoring.engine';
import { RiskScore } from '../value-objects/risk-score.vo';
import { expect, it, describe } from '@jest/globals';

describe('RiskScoringEngine', () => {
  describe('calculateWeightedScore', () => {
    it('computes the correct weighted total for known inputs', () => {
      const engine = new RiskScoringEngine();
      const { score } = engine.calculateWeightedScore({
        productType: 50,
        transactionAnomaly: 50,
        jurisdictionalRisk: 50,
        pepStatus: 50,
        amlResults: 50,
      });
      // 50*0.2 + 50*0.25 + 50*0.2 + 50*0.15 + 50*0.2 = 50 * (sum of weights = 1.0) = 50
      expect(score.getValue()).toBe(50);
    });

    it('weighs transactionAnomaly (0.25) more heavily than pepStatus (0.15)', () => {
      const engine = new RiskScoringEngine();
      const highAnomaly = engine.calculateWeightedScore({
        productType: 0,
        transactionAnomaly: 100,
        jurisdictionalRisk: 0,
        pepStatus: 0,
        amlResults: 0,
      });
      const highPep = engine.calculateWeightedScore({
        productType: 0,
        transactionAnomaly: 0,
        jurisdictionalRisk: 0,
        pepStatus: 100,
        amlResults: 0,
      });
      expect(highAnomaly.score.getValue()).toBeGreaterThan(highPep.score.getValue());
      expect(highAnomaly.score.getValue()).toBe(25); // 100 * 0.25
      expect(highPep.score.getValue()).toBe(15); // 100 * 0.15
    });

    it('returns a per-factor weighted breakdown alongside the total', () => {
      const engine = new RiskScoringEngine();
      const { breakdown } = engine.calculateWeightedScore({
        productType: 100,
        transactionAnomaly: 0,
        jurisdictionalRisk: 0,
        pepStatus: 0,
        amlResults: 0,
      });
      expect(breakdown.productType).toBe(20); // 100 * 0.2
      expect(breakdown.transactionAnomaly).toBe(0);
    });

    it('produces 100 when all sub-scores are at maximum', () => {
      const engine = new RiskScoringEngine();
      const { score } = engine.calculateWeightedScore({
        productType: 100,
        transactionAnomaly: 100,
        jurisdictionalRisk: 100,
        pepStatus: 100,
        amlResults: 100,
      });
      expect(score.getValue()).toBe(100);
    });

    it('produces 0 when all sub-scores are at minimum', () => {
      const engine = new RiskScoringEngine();
      const { score } = engine.calculateWeightedScore({
        productType: 0,
        transactionAnomaly: 0,
        jurisdictionalRisk: 0,
        pepStatus: 0,
        amlResults: 0,
      });
      expect(score.getValue()).toBe(0);
    });

    it('rejects a sub-score below 0', () => {
      const engine = new RiskScoringEngine();
      expect(() =>
        engine.calculateWeightedScore({
          productType: -1,
          transactionAnomaly: 0,
          jurisdictionalRisk: 0,
          pepStatus: 0,
          amlResults: 0,
        }),
      ).toThrow(/must be between 0 and 100/);
    });

    it('rejects a sub-score above 100', () => {
      const engine = new RiskScoringEngine();
      expect(() =>
        engine.calculateWeightedScore({
          productType: 0,
          transactionAnomaly: 0,
          jurisdictionalRisk: 0,
          pepStatus: 0,
          amlResults: 101,
        }),
      ).toThrow(/must be between 0 and 100/);
    });
  });

  describe('applyDeltas — B4.4 re-verification cascade scenario', () => {
    it('reproduces the exact spec example: 42 base + 15 jurisdictional + 12 transaction = 69', () => {
      const engine = new RiskScoringEngine();
      const baseScore = RiskScore.create(42);
      const baseBreakdown = {
        productType: 0,
        transactionAnomaly: 0,
        jurisdictionalRisk: 0,
        pepStatus: 0,
        amlResults: 0,
      };
      const result = engine.applyDeltas(baseScore, baseBreakdown, [
        { reason: 'Director of company in FATF high-risk jurisdiction', points: 15 },
        { reason: 'Transaction pattern anomaly detected', points: 12 },
      ]);
      expect(result.score.getValue()).toBe(69);
      expect(result.score.exceedsEddThreshold()).toBe(true); // 69 > 60
    });

    it('clamps the result at 100 even if deltas would push it higher', () => {
      const engine = new RiskScoringEngine();
      const baseScore = RiskScore.create(95);
      const breakdown = {
        productType: 0,
        transactionAnomaly: 0,
        jurisdictionalRisk: 0,
        pepStatus: 0,
        amlResults: 0,
      };
      const result = engine.applyDeltas(baseScore, breakdown, [
        { reason: 'Major escalation', points: 30 },
      ]);
      expect(result.score.getValue()).toBe(100);
    });

    it('clamps the result at 0 even if deltas would push it negative', () => {
      const engine = new RiskScoringEngine();
      const baseScore = RiskScore.create(5);
      const breakdown = {
        productType: 0,
        transactionAnomaly: 0,
        jurisdictionalRisk: 0,
        pepStatus: 0,
        amlResults: 0,
      };
      const result = engine.applyDeltas(baseScore, breakdown, [
        { reason: 'Risk factor resolved', points: -20 },
      ]);
      expect(result.score.getValue()).toBe(0);
    });

    it('applies multiple positive and negative deltas correctly in combination', () => {
      const engine = new RiskScoringEngine();
      const baseScore = RiskScore.create(50);
      const breakdown = {
        productType: 0,
        transactionAnomaly: 0,
        jurisdictionalRisk: 0,
        pepStatus: 0,
        amlResults: 0,
      };
      const result = engine.applyDeltas(baseScore, breakdown, [
        { reason: 'up', points: 20 },
        { reason: 'down', points: -10 },
      ]);
      expect(result.score.getValue()).toBe(60);
    });

    it('preserves the existing breakdown unchanged (deltas do not recompute per-factor weights)', () => {
      const engine = new RiskScoringEngine();
      const baseScore = RiskScore.create(42);
      const breakdown = {
        productType: 8,
        transactionAnomaly: 10,
        jurisdictionalRisk: 8,
        pepStatus: 6,
        amlResults: 10,
      };
      const result = engine.applyDeltas(baseScore, breakdown, [{ reason: 'x', points: 5 }]);
      expect(result.breakdown).toEqual(breakdown);
    });

    it('returns the applied deltas for audit trail purposes', () => {
      const engine = new RiskScoringEngine();
      const baseScore = RiskScore.create(42);
      const breakdown = {
        productType: 0,
        transactionAnomaly: 0,
        jurisdictionalRisk: 0,
        pepStatus: 0,
        amlResults: 0,
      };
      const deltas = [{ reason: 'Jurisdictional change', points: 15 }];
      const result = engine.applyDeltas(baseScore, breakdown, deltas);
      expect(result.appliedDeltas).toEqual(deltas);
    });
  });
});
