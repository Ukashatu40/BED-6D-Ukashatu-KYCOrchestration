// src/domain/entities/customer.entity.ts
import { KycTier } from '../value-objects/kyc-tier.enum';
import { VerificationStatus } from '../value-objects/verification-status.enum';
import { RiskScore } from '../value-objects/risk-score.vo';

export interface RiskFactorBreakdown {
  productType: number;
  transactionAnomaly: number;
  jurisdictionalRisk: number;
  pepStatus: number;
  amlResults: number;
}

export interface CustomerProps {
  customerId: string;
  externalId: string;
  fullNameEncrypted: Buffer;
  dateOfBirthEncrypted: Buffer;
  kycTier: KycTier;
  kycStatus: VerificationStatus;
  riskScore: RiskScore;
  riskFactors: RiskFactorBreakdown;
  ckycKin?: string | null;
  lastVerifiedAt?: Date | null;
  nextVerificationDue?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

/**
 * Core Customer aggregate root. PII fields arrive already encrypted at the
 * boundary (EncryptionService) — this entity never handles plaintext PII.
 */
export class Customer {
  private props: CustomerProps;

  private constructor(props: CustomerProps) {
    this.props = props;
  }

  static create(props: Omit<CustomerProps, 'createdAt' | 'updatedAt' | 'deletedAt'>): Customer {
    if (!props.externalId || props.externalId.trim().length === 0) {
      throw new Error('Customer.externalId is required');
    }
    if (props.ckycKin && !/^\d{14}$/.test(props.ckycKin)) {
      throw new Error('CKYC KIN must be exactly 14 digits');
    }
    const now = new Date();
    return new Customer({
      ...props,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
  }

  static reconstitute(props: CustomerProps): Customer {
    return new Customer(props);
  }

  get customerId(): string {
    return this.props.customerId;
  }

  get kycTier(): KycTier {
    return this.props.kycTier;
  }

  get kycStatus(): VerificationStatus {
    return this.props.kycStatus;
  }

  get riskScore(): RiskScore {
    return this.props.riskScore;
  }

  get ckycKin(): string | null | undefined {
    return this.props.ckycKin;
  }

  /** Assigns a CKYC KIN once a registry search/upload succeeds. Idempotent-safe: same KIN is a no-op. */
  assignCkycKin(kin: string): void {
    if (!/^\d{14}$/.test(kin)) {
      throw new Error('CKYC KIN must be exactly 14 digits');
    }
    if (this.props.ckycKin && this.props.ckycKin !== kin) {
      throw new Error(`Customer already has a different CKYC KIN assigned (${this.props.ckycKin})`);
    }
    this.props.ckycKin = kin;
    this.touch();
  }

  updateRiskScore(newScore: RiskScore, factors: RiskFactorBreakdown): void {
    this.props.riskScore = newScore;
    this.props.riskFactors = factors;
    this.touch();
  }

  upgradeTier(newTier: KycTier): void {
    const tierOrder = [KycTier.MINIMUM, KycTier.FULL, KycTier.EDD];
    if (tierOrder.indexOf(newTier) <= tierOrder.indexOf(this.props.kycTier)) {
      throw new Error(
        `Cannot "upgrade" from ${this.props.kycTier} to ${newTier} — not a forward tier move`,
      );
    }
    this.props.kycTier = newTier;
    this.touch();
  }

  transitionStatus(newStatus: VerificationStatus): void {
    // Guard conditions live in VerificationStateMachine (Day 3). This setter
    // exists so the state machine has a single point of entry into the entity.
    this.props.kycStatus = newStatus;
    this.touch();
  }

  isDueForReVerification(asOf: Date = new Date()): boolean {
    return !!this.props.nextVerificationDue && this.props.nextVerificationDue <= asOf;
  }

  private touch(): void {
    this.props.updatedAt = new Date();
  }

  toProps(): Readonly<CustomerProps> {
    return { ...this.props };
  }
}
