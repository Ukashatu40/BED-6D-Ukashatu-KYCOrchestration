// src/api/risk/risk.controller.spec.ts
import { RiskController } from './risk.controller';
import { CustomerRepositoryPort } from '../../application/ports/customer-repository.port';
import { InMemoryAuditTrail } from '../../infrastructure/audit/in-memory-audit-trail';
import { Customer } from '../../domain/entities/customer.entity';
import { KycTier } from '../../domain/value-objects/kyc-tier.enum';
import { VerificationStatus } from '../../domain/value-objects/verification-status.enum';
import { RiskScore } from '../../domain/value-objects/risk-score.vo';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { expect, it, describe } from '@jest/globals';

class FakeCustomerRepository implements CustomerRepositoryPort {
  private customers = new Map<string, Customer>();
  seed(c: Customer) {
    this.customers.set(c.customerId, c);
  }
  async save(c: Customer): Promise<void> {
    this.customers.set(c.customerId, c);
  }
  async findById(id: string): Promise<Customer | null> {
    return this.customers.get(id) ?? null;
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

function makeCustomer(): Customer {
  return Customer.create({
    customerId: 'cust-001',
    externalId: 'ext-001',
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

describe('RiskController', () => {
  describe('getScore', () => {
    it('returns the current score and breakdown for an existing customer', async () => {
      const repo = new FakeCustomerRepository();
      repo.seed(makeCustomer());
      const controller = new RiskController(repo, new InMemoryAuditTrail());
      const result = await controller.getScore('cust-001', repo);
      expect(result.riskScore).toBe(42);
      expect(result.exceedsEddThreshold).toBe(false);
    });

    it('throws NotFoundException for an unknown customer', async () => {
      const repo = new FakeCustomerRepository();
      const controller = new RiskController(repo, new InMemoryAuditTrail());
      await expect(controller.getScore('nonexistent', repo)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('recalculate', () => {
    it('performs a FULL_RECALCULATION and returns the result with a correlationId', async () => {
      const repo = new FakeCustomerRepository();
      repo.seed(makeCustomer());
      const controller = new RiskController(repo, new InMemoryAuditTrail());
      const result = await controller.recalculate('cust-001', {
        kind: 'FULL_RECALCULATION',
        factors: {
          productType: 100,
          transactionAnomaly: 100,
          jurisdictionalRisk: 100,
          pepStatus: 100,
          amlResults: 100,
        },
      } as any);
      expect(result.newScore).toBe(100);
      expect(result.correlationId).toBeDefined();
    });

    it('performs a DELTA_APPLICATION reproducing the B4.4 scenario', async () => {
      const repo = new FakeCustomerRepository();
      repo.seed(makeCustomer());
      const controller = new RiskController(repo, new InMemoryAuditTrail());
      const result = await controller.recalculate('cust-001', {
        kind: 'DELTA_APPLICATION',
        deltas: [
          { reason: 'Jurisdictional risk increase', points: 15 },
          { reason: 'Transaction anomaly detected', points: 12 },
        ],
      } as any);
      expect(result.newScore).toBe(69);
      expect(result.tierUpgraded).toBe(true);
    });

    it('throws BadRequestException when kind=FULL_RECALCULATION but factors is missing', async () => {
      const repo = new FakeCustomerRepository();
      repo.seed(makeCustomer());
      const controller = new RiskController(repo, new InMemoryAuditTrail());
      await expect(
        controller.recalculate('cust-001', { kind: 'FULL_RECALCULATION' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException when kind=DELTA_APPLICATION but deltas is empty', async () => {
      const repo = new FakeCustomerRepository();
      repo.seed(makeCustomer());
      const controller = new RiskController(repo, new InMemoryAuditTrail());
      await expect(
        controller.recalculate('cust-001', { kind: 'DELTA_APPLICATION', deltas: [] } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws NotFoundException when the customer does not exist', async () => {
      const repo = new FakeCustomerRepository();
      const controller = new RiskController(repo, new InMemoryAuditTrail());
      await expect(
        controller.recalculate('nonexistent', {
          kind: 'FULL_RECALCULATION',
          factors: {
            productType: 0,
            transactionAnomaly: 0,
            jurisdictionalRisk: 0,
            pepStatus: 0,
            amlResults: 0,
          },
        } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
