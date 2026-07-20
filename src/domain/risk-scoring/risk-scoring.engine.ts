// src/domain/risk-scoring/risk-scoring.engine.ts
import { RiskScore } from '../value-objects/risk-score.vo';
import { RiskFactorBreakdown } from '../entities/customer.entity';

/** Per Section D.5: weighted factors summing to 1.0. */
export const RISK_FACTOR_WEIGHTS: Record<keyof RiskFactorBreakdown, number> = {
  productType: 0.2,
  transactionAnomaly: 0.25,
  jurisdictionalRisk: 0.2,
  pepStatus: 0.15,
  amlResults: 0.2,
};

export interface RiskFactorInputs {
  productType: number; // 0-100 raw sub-score
  transactionAnomaly: number;
  jurisdictionalRisk: number;
  pepStatus: number;
  amlResults: number;
}

export interface RiskDelta {
  reason: string;
  points: number; // signed — positive increases risk, negative decreases it
}

/**
 * Pure domain calculation — no persistence, no audit logging, no
 * side effects. Two distinct operations, matching two distinct mechanics
 * the spec describes:
 *
 * (1) calculateWeightedScore: full weighted recompute from five 0-100
 *     sub-scores (Section D.5's "weighted factors" formula) — used when a
 *     fresh, complete risk assessment is available (e.g. after a full AML
 *     screening result).
 *
 * (2) applyDeltas: additive point adjustments to an EXISTING score
 *     (Section B4.4's re-verification cascade: 42 + 15 + 12 = 69) — used
 *     when discrete trigger events (jurisdiction change, transaction
 *     anomaly) arrive independently rather than as part of a full
 *     re-assessment.
 *
 * Both share the same RiskScore value object (Day 1) and its EDD_THRESHOLD
 * constant, so "exceeds EDD threshold" means the same thing regardless of
 * which path produced the score.
 */
export class RiskScoringEngine {
  calculateWeightedScore(inputs: RiskFactorInputs): {
    score: RiskScore;
    breakdown: RiskFactorBreakdown;
  } {
    this.assertValidSubScores(inputs);

    const breakdown: RiskFactorBreakdown = {
      productType: inputs.productType * RISK_FACTOR_WEIGHTS.productType,
      transactionAnomaly: inputs.transactionAnomaly * RISK_FACTOR_WEIGHTS.transactionAnomaly,
      jurisdictionalRisk: inputs.jurisdictionalRisk * RISK_FACTOR_WEIGHTS.jurisdictionalRisk,
      pepStatus: inputs.pepStatus * RISK_FACTOR_WEIGHTS.pepStatus,
      amlResults: inputs.amlResults * RISK_FACTOR_WEIGHTS.amlResults,
    };

    const rawTotal = Object.values(breakdown).reduce((sum, weighted) => sum + weighted, 0);
    const clamped = Math.min(Math.max(rawTotal, RiskScore.MIN), RiskScore.MAX);

    return { score: RiskScore.create(clamped), breakdown };
  }

  /**
   * Applies one or more signed point deltas to an existing score, clamped
   * to [0, 100]. The breakdown passed in is NOT recomputed against the new
   * total — deltas represent ad-hoc trigger events (jurisdiction change,
   * transaction pattern anomaly) that don't map cleanly back onto the
   * five weighted sub-score categories, so the existing breakdown is
   * returned unchanged. A subsequent calculateWeightedScore call (e.g. at
   * the next full re-verification) is what reconciles the breakdown with
   * reality — this method is for the immediate score/tier-threshold
   * question, not for maintaining an always-accurate breakdown.
   */
  applyDeltas(
    currentScore: RiskScore,
    currentBreakdown: RiskFactorBreakdown,
    deltas: RiskDelta[],
  ): { score: RiskScore; breakdown: RiskFactorBreakdown; appliedDeltas: RiskDelta[] } {
    const totalDelta = deltas.reduce((sum, d) => sum + d.points, 0);
    const rawNewValue = currentScore.getValue() + totalDelta;
    const clamped = Math.min(Math.max(rawNewValue, RiskScore.MIN), RiskScore.MAX);

    return {
      score: RiskScore.create(clamped),
      breakdown: currentBreakdown,
      appliedDeltas: deltas,
    };
  }

  private assertValidSubScores(inputs: RiskFactorInputs): void {
    for (const [key, value] of Object.entries(inputs)) {
      if (value < 0 || value > 100) {
        throw new Error(`Risk factor "${key}" must be between 0 and 100, got ${value}`);
      }
    }
  }
}
