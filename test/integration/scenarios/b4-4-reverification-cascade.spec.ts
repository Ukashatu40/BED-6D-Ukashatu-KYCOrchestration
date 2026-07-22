// test/integration/scenarios/b4-4-reverification-cascade.spec.ts
import { RecalculateRiskScoreUseCase } from '../../../src/application/use-cases/recalculate-risk-score.use-case';
import { InMemoryAuditTrail } from '../../../src/infrastructure/audit/in-memory-audit-trail';
import { Customer } from '../../../src/domain/entities/customer.entity';
import { CustomerRepositoryPort } from '../../../src/application/ports/customer-repository.port';
import { KycTier } from '../../../src/domain/value-objects/kyc-tier.enum';
import { VerificationStatus } from '../../../src/domain/value-objects/verification-status.enum';
import { RiskScore } from '../../../src/domain/value-objects/risk-score.vo';
import { AuditActorType } from '../../../src/domain/entities/audit-event.entity';
import { describe, it, expect } from '@jest/globals';

class InMemoryCustomerRepo implements CustomerRepositoryPort {
  private customers = new Map<string, Customer>();
  seed(c: Customer) {
    this.customers.set(c.customerId, c);
  }
  async save(c: Customer) {
    this.customers.set(c.customerId, c);
  }
  async findById(id: string) {
    return this.customers.get(id) ?? null;
  }
  async findByExternalId() {
    return null;
  }
  async findByCkycKin() {
    return null;
  }
  async findDueForReVerification() {
    return [];
  }
}

/**
 * Reproduces Section B4.4 exactly: a Full KYC customer at risk score 42
 * experiences two simultaneous risk-relevant changes — jurisdictional
 * (+15) and transaction pattern anomaly (+12) — combining to 69, crossing
 * the EDD threshold of 60, triggering an automatic tier upgrade with full
 * justification. Fully supported by Day 5's RecalculateRiskScoreUseCase
 * with zero gaps — this is the one scenario where "what's built" and
 * "what the spec asks for" line up completely.
 */
describe('Scenario B4.4 — Re-Verification Cascade', () => {
  const actorFields = {
    actorId: 'risk-engine',
    actorType: AuditActorType.SYSTEM,
    correlationId: 'corr-b44',
  };

  function makeFullKycCustomerAtScore42(): Customer {
    return Customer.create({
      customerId: 'cust-b44',
      externalId: 'ext-b44',
      fullNameEncrypted: Buffer.from('x'),
      dateOfBirthEncrypted: Buffer.from('x'),
      kycTier: KycTier.FULL,
      kycStatus: VerificationStatus.VERIFIED,
      riskScore: RiskScore.create(42),
      riskFactors: {
        productType: 0,
        transactionAnomaly: 0,
        jurisdictionalRisk: 0,
        pepStatus: 0,
        amlResults: 0,
      },
      ckycKin: null,
      lastVerifiedAt: null,
      nextVerificationDue: null,
    });
  }

  it('recalculates the combined score correctly: 42 + 15 + 12 = 69', async () => {
    const repo = new InMemoryCustomerRepo();
    repo.seed(makeFullKycCustomerAtScore42());
    const useCase = new RecalculateRiskScoreUseCase(repo, new InMemoryAuditTrail());

    const result = await useCase.execute({
      kind: 'DELTA_APPLICATION',
      customerId: 'cust-b44',
      deltas: [
        {
          reason:
            'Customer appointed director of company in FATF-identified high-risk jurisdiction',
          points: 15,
        },
        {
          reason:
            'Transaction pattern shifted from regular INR 50,000 repayments to irregular INR 5-15 lakh transfers',
          points: 12,
        },
      ],
      ...actorFields,
    });

    expect(result.previousScore).toBe(42);
    expect(result.newScore).toBe(69);
  });

  it('determines the customer now qualifies for EDD (score exceeds threshold of 60)', async () => {
    const repo = new InMemoryCustomerRepo();
    repo.seed(makeFullKycCustomerAtScore42());
    const useCase = new RecalculateRiskScoreUseCase(repo, new InMemoryAuditTrail());
    const result = await useCase.execute({
      kind: 'DELTA_APPLICATION',
      customerId: 'cust-b44',
      deltas: [
        { reason: 'Jurisdictional risk factor increase', points: 15 },
        { reason: 'Transaction anomaly detected', points: 12 },
      ],
      ...actorFields,
    });
    expect(result.tierUpgraded).toBe(true);
    expect(result.previousTier).toBe(KycTier.FULL);
    expect(result.newTier).toBe(KycTier.EDD);
  });

  it('generates a tier upgrade audit event with full justification of both triggering factors', async () => {
    const repo = new InMemoryCustomerRepo();
    repo.seed(makeFullKycCustomerAtScore42());
    const auditTrail = new InMemoryAuditTrail();
    const useCase = new RecalculateRiskScoreUseCase(repo, auditTrail);
    await useCase.execute({
      kind: 'DELTA_APPLICATION',
      customerId: 'cust-b44',
      deltas: [
        { reason: 'Jurisdictional risk factor increase (+15)', points: 15 },
        { reason: 'Transaction pattern anomaly (+12)', points: 12 },
      ],
      ...actorFields,
    });
    const events = auditTrail.getEventsForCustomer('cust-b44');
    const upgradeEvent = events.find((e) => e.toProps().eventType === 'RiskTierUpgraded');
    expect(upgradeEvent).toBeDefined();
    const justification = upgradeEvent!.toProps().eventPayload.justification as string;
    expect(justification).toContain('Jurisdictional risk factor increase');
    expect(justification).toContain('Transaction pattern anomaly');
  });

  it('persists the updated customer with the new tier and score', async () => {
    const repo = new InMemoryCustomerRepo();
    repo.seed(makeFullKycCustomerAtScore42());
    const useCase = new RecalculateRiskScoreUseCase(repo, new InMemoryAuditTrail());
    await useCase.execute({
      kind: 'DELTA_APPLICATION',
      customerId: 'cust-b44',
      deltas: [
        { reason: 'Jurisdictional risk factor increase', points: 15 },
        { reason: 'Transaction anomaly detected', points: 12 },
      ],
      ...actorFields,
    });
    const reloaded = await repo.findById('cust-b44');
    expect(reloaded!.kycTier).toBe(KycTier.EDD);
    expect(reloaded!.riskScore.getValue()).toBe(69);
  });

  it('full audit trail integrity: RiskScoreCalculated and RiskTierUpgraded events correctly hash-chained', async () => {
    const repo = new InMemoryCustomerRepo();
    repo.seed(makeFullKycCustomerAtScore42());
    const auditTrail = new InMemoryAuditTrail();
    const useCase = new RecalculateRiskScoreUseCase(repo, auditTrail);
    await useCase.execute({
      kind: 'DELTA_APPLICATION',
      customerId: 'cust-b44',
      deltas: [
        { reason: 'Jurisdictional risk factor increase', points: 15 },
        { reason: 'Transaction anomaly detected', points: 12 },
      ],
      ...actorFields,
    });
    const events = auditTrail.getEventsForCustomer('cust-b44');
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.verifyOwnIntegrity())).toBe(true);
    expect(events[1].previousEventHash).toBe(events[0].eventHash);
  });
});
