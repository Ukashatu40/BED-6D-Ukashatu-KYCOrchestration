// src/domain/value-objects/risk-score.vo.ts
/**
 * Immutable value object for a customer's risk score.
 * Enforces the 0–100 bound and the EDD escalation threshold (60) defined in Part D.5.
 */
export class RiskScore {
  public static readonly EDD_THRESHOLD = 60;
  public static readonly MIN = 0;
  public static readonly MAX = 100;

  private readonly value: number;

  private constructor(value: number) {
    this.value = value;
  }

  static create(value: number): RiskScore {
    if (!Number.isFinite(value)) {
      throw new Error('RiskScore must be a finite number');
    }
    if (value < RiskScore.MIN || value > RiskScore.MAX) {
      throw new Error(
        `RiskScore must be between ${RiskScore.MIN} and ${RiskScore.MAX}, got ${value}`,
      );
    }
    return new RiskScore(Math.round(value));
  }

  getValue(): number {
    return this.value;
  }

  exceedsEddThreshold(): boolean {
    return this.value > RiskScore.EDD_THRESHOLD;
  }

  equals(other: RiskScore): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return String(this.value);
  }
}
