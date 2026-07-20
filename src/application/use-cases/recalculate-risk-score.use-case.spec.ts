// src/application/use-cases/recalculate-risk-score.use-case.spec.ts
import {
  CustomerNotFoundError,
  RecalculateRiskScoreUseCase,
} from './recalculate-risk-score.use-case';
import { InMemoryAuditTrail } from '../../infrastructure/audit/in-memory-audit-trail';
import { Customer } from '../../domain/entities/customer.entity';
import { CustomerRepositoryPort } from '../ports/customer-repository.port';
import { KycTier } from '../../domain/value-objects/kyc-tier.enum';
import { VerificationStatus } from '../../domain/value-objects/verification-status.enum';
import { RiskScore } from '../../domain/value-objects/risk-score.vo';
import { AuditActorType } from '../../domain/entities/audit-event.entity';
import { expect, it, describe } from '@jest/globals';

class InMemoryCustomerRepositoryForTest implements CustomerRepositoryPort {
  private customers = new Map<string, Customer>();

  seed(customer: Customer) {
    this.customers.set(customer.customerId, customer);
  }

  async save(customer: Customer): Promise<void> {
    this.customers.set(customer.customerId, customer);
  }
  async findById(customerId: string): Promise<Customer | null> {
    return this.customers.get(customerId) ?? null;
  }
  async findByExternalId(): Promise<Customer | null> {
    return null;
  }
  async findByCkycKin(): Promise<Customer | null> {
    return null;
  }
  async findDueForReVerification(): Promise<Customer[]> {
    return [];
  }
}

function makeCustomer(overrides: { tier?: KycTier; riskScore?: number } = {}): Customer {
  return Customer.create({
    customerId: 'cust-001',
    externalId: 'ext-001',
    fullNameEncrypted: Buffer.from('x'),
    dateOfBirthEncrypted: Buffer.from('x'),
    kycTier: overrides.tier ?? KycTier.FULL,
    kycStatus: VerificationStatus.VERIFIED,
    riskScore: RiskScore.create(overrides.riskScore ?? 42),
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

const actorFields = {
  actorId: 'risk-engine',
  actorType: AuditActorType.SYSTEM,
  correlationId: 'corr-001',
};

describe('RecalculateRiskScoreUseCase', () => {
  it('throws CustomerNotFoundError for an unknown customer', async () => {
    const repo = new InMemoryCustomerRepositoryForTest();
    const useCase = new RecalculateRiskScoreUseCase(repo, new InMemoryAuditTrail());
    await expect(
      useCase.execute({
        kind: 'FULL_RECALCULATION',
        customerId: 'nonexistent',
        factors: {
          productType: 0,
          transactionAnomaly: 0,
          jurisdictionalRisk: 0,
          pepStatus: 0,
          amlResults: 0,
        },
        ...actorFields,
      }),
    ).rejects.toBeInstanceOf(CustomerNotFoundError);
  });

  describe('FULL_RECALCULATION', () => {
    it('updates the customer risk score and persists it', async () => {
      const repo = new InMemoryCustomerRepositoryForTest();
      repo.seed(makeCustomer({ riskScore: 10 }));
      const useCase = new RecalculateRiskScoreUseCase(repo, new InMemoryAuditTrail());
      const result = await useCase.execute({
        kind: 'FULL_RECALCULATION',
        customerId: 'cust-001',
        factors: {
          productType: 100,
          transactionAnomaly: 100,
          jurisdictionalRisk: 100,
          pepStatus: 100,
          amlResults: 100,
        },
        ...actorFields,
      });
      expect(result.newScore).toBe(100);
      const reloaded = await repo.findById('cust-001');
      expect(reloaded!.riskScore.getValue()).toBe(100);
    });

    it('records a RiskScoreCalculated audit event with previous and new score', async () => {
      const repo = new InMemoryCustomerRepositoryForTest();
      repo.seed(makeCustomer({ riskScore: 10 }));
      const auditTrail = new InMemoryAuditTrail();
      const useCase = new RecalculateRiskScoreUseCase(repo, auditTrail);
      await useCase.execute({
        kind: 'FULL_RECALCULATION',
        customerId: 'cust-001',
        factors: {
          productType: 0,
          transactionAnomaly: 0,
          jurisdictionalRisk: 0,
          pepStatus: 0,
          amlResults: 0,
        },
        ...actorFields,
      });
      const events = auditTrail.getEventsForCustomer('cust-001');
      const calcEvent = events.find((e) => e.toProps().eventType === 'RiskScoreCalculated');
      expect(calcEvent?.toProps().eventPayload).toMatchObject({ previousScore: 10, newScore: 0 });
    });

    it('does NOT upgrade tier when the score stays below the EDD threshold', async () => {
      const repo = new InMemoryCustomerRepositoryForTest();
      repo.seed(makeCustomer({ tier: KycTier.FULL, riskScore: 10 }));
      const useCase = new RecalculateRiskScoreUseCase(repo, new InMemoryAuditTrail());
      const result = await useCase.execute({
        kind: 'FULL_RECALCULATION',
        customerId: 'cust-001',
        factors: {
          productType: 50,
          transactionAnomaly: 0,
          jurisdictionalRisk: 0,
          pepStatus: 0,
          amlResults: 0,
        }, // 50*0.2=10
        ...actorFields,
      });
      expect(result.tierUpgraded).toBe(false);
      expect(result.newTier).toBe(KycTier.FULL);
    });

    it('upgrades tier to EDD when the score crosses the threshold', async () => {
      const repo = new InMemoryCustomerRepositoryForTest();
      repo.seed(makeCustomer({ tier: KycTier.FULL, riskScore: 10 }));
      const useCase = new RecalculateRiskScoreUseCase(repo, new InMemoryAuditTrail());
      const result = await useCase.execute({
        kind: 'FULL_RECALCULATION',
        customerId: 'cust-001',
        factors: {
          productType: 100,
          transactionAnomaly: 100,
          jurisdictionalRisk: 100,
          pepStatus: 100,
          amlResults: 100,
        }, // = 100
        ...actorFields,
      });
      expect(result.tierUpgraded).toBe(true);
      expect(result.previousTier).toBe(KycTier.FULL);
      expect(result.newTier).toBe(KycTier.EDD);
    });

    it('does not attempt a tier "upgrade" if the customer is already at EDD', async () => {
      const repo = new InMemoryCustomerRepositoryForTest();
      repo.seed(makeCustomer({ tier: KycTier.EDD, riskScore: 65 }));
      const useCase = new RecalculateRiskScoreUseCase(repo, new InMemoryAuditTrail());
      const result = await useCase.execute({
        kind: 'FULL_RECALCULATION',
        customerId: 'cust-001',
        factors: {
          productType: 100,
          transactionAnomaly: 100,
          jurisdictionalRisk: 100,
          pepStatus: 100,
          amlResults: 100,
        },
        ...actorFields,
      });
      // Score is still recalculated, but tierUpgraded is false since there's
      // no further tier above EDD to upgrade to — Customer.upgradeTier would
      // throw if called here, so the use case must correctly skip it.
      expect(result.tierUpgraded).toBe(false);
      expect(result.newTier).toBe(KycTier.EDD);
    });
  });

  describe('DELTA_APPLICATION — B4.4 re-verification cascade', () => {
    it('reproduces the spec scenario end to end: FULL tier customer at score 42 crosses to EDD via two deltas', async () => {
      const repo = new InMemoryCustomerRepositoryForTest();
      repo.seed(makeCustomer({ tier: KycTier.FULL, riskScore: 42 }));
      const auditTrail = new InMemoryAuditTrail();
      const useCase = new RecalculateRiskScoreUseCase(repo, auditTrail);

      const result = await useCase.execute({
        kind: 'DELTA_APPLICATION',
        customerId: 'cust-001',
        deltas: [
          { reason: 'Director of company in FATF high-risk jurisdiction', points: 15 },
          { reason: 'Transaction pattern anomaly detected', points: 12 },
        ],
        ...actorFields,
      });

      expect(result.newScore).toBe(69);
      expect(result.tierUpgraded).toBe(true);
      expect(result.newTier).toBe(KycTier.EDD);

      const events = auditTrail.getEventsForCustomer('cust-001');
      const upgradeEvent = events.find((e) => e.toProps().eventType === 'RiskTierUpgraded');
      expect(upgradeEvent).toBeDefined();
      expect(upgradeEvent!.toProps().eventPayload.justification).toContain(
        'FATF high-risk jurisdiction',
      );
      expect(upgradeEvent!.toProps().eventPayload.justification).toContain(
        'Transaction pattern anomaly',
      );
    });

    it('records deltas in the RiskScoreCalculated event payload for audit traceability', async () => {
      const repo = new InMemoryCustomerRepositoryForTest();
      repo.seed(makeCustomer({ riskScore: 42 }));
      const auditTrail = new InMemoryAuditTrail();
      const useCase = new RecalculateRiskScoreUseCase(repo, auditTrail);
      await useCase.execute({
        kind: 'DELTA_APPLICATION',
        customerId: 'cust-001',
        deltas: [{ reason: 'Test delta', points: 5 }],
        ...actorFields,
      });
      const events = auditTrail.getEventsForCustomer('cust-001');
      const calcEvent = events.find((e) => e.toProps().eventType === 'RiskScoreCalculated');
      expect(calcEvent?.toProps().eventPayload.deltas).toEqual([
        { reason: 'Test delta', points: 5 },
      ]);
    });

    it('records exactly one RiskScoreCalculated event and no RiskTierUpgraded event when the threshold is not crossed', async () => {
      const repo = new InMemoryCustomerRepositoryForTest();
      repo.seed(makeCustomer({ tier: KycTier.FULL, riskScore: 20 }));
      const auditTrail = new InMemoryAuditTrail();
      const useCase = new RecalculateRiskScoreUseCase(repo, auditTrail);
      await useCase.execute({
        kind: 'DELTA_APPLICATION',
        customerId: 'cust-001',
        deltas: [{ reason: 'Minor factor', points: 5 }],
        ...actorFields,
      });
      const events = auditTrail.getEventsForCustomer('cust-001');
      expect(events).toHaveLength(1);
      expect(events[0].toProps().eventType).toBe('RiskScoreCalculated');
    });
  });

  describe('audit event hash chaining across recalculation + tier upgrade', () => {
    it('the RiskTierUpgraded event correctly chains from the RiskScoreCalculated event', async () => {
      const repo = new InMemoryCustomerRepositoryForTest();
      repo.seed(makeCustomer({ tier: KycTier.FULL, riskScore: 42 }));
      const auditTrail = new InMemoryAuditTrail();
      const useCase = new RecalculateRiskScoreUseCase(repo, auditTrail);
      await useCase.execute({
        kind: 'DELTA_APPLICATION',
        customerId: 'cust-001',
        deltas: [{ reason: 'x', points: 30 }],
        ...actorFields,
      });
      const events = auditTrail.getEventsForCustomer('cust-001');
      expect(events).toHaveLength(2);
      expect(events[1].previousEventHash).toBe(events[0].eventHash);
    });
  });
});
