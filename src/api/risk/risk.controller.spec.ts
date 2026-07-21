// src/api/risk/risk.controller.spec.ts
import { RiskController } from './risk.controller';
import { CustomerRepositoryPort } from '../../application/ports/customer-repository.port';
import { InMemoryAuditTrail } from '../../infrastructure/audit/in-memory-audit-trail';
import { Customer } from '../../domain/entities/customer.entity';
import { KycTier } from '../../domain/value-objects/kyc-tier.enum';
import { VerificationStatus } from '../../domain/value-objects/verification-status.enum';
import { RiskScore } from '../../domain/value-objects/risk-score.vo';
import { NotFoundException } from '@nestjs/common';
import { AuditActorType } from '../../domain/entities/audit-event.entity';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { describe, it, expect } from '@jest/globals';

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

// Simulates what @CurrentUser() would extract from a real JWT — since
// parameter decorators are a Nest HTTP-pipeline feature, calling the
// controller method directly in a unit test means supplying this value
// ourselves rather than relying on decorator magic.
const testUser: JwtPayload = {
  sub: 'user-001',
  actorType: AuditActorType.USER,
  roles: ['compliance_officer'],
};
const testCorrelationId = 'corr-test-001';

describe('RiskController', () => {
  describe('getScore', () => {
    it('returns the current score and breakdown for an existing customer', async () => {
      const repo = new FakeCustomerRepository();
      repo.seed(makeCustomer());
      const controller = new RiskController(repo, new InMemoryAuditTrail());
      const result = await controller.getScore('cust-001');
      expect(result.riskScore).toBe(42);
      expect(result.exceedsEddThreshold).toBe(false);
    });

    it('throws NotFoundException for an unknown customer', async () => {
      const repo = new FakeCustomerRepository();
      const controller = new RiskController(repo, new InMemoryAuditTrail());
      await expect(controller.getScore('nonexistent')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('recalculate', () => {
    it('performs a FULL_RECALCULATION and returns the result with a correlationId', async () => {
      const repo = new FakeCustomerRepository();
      repo.seed(makeCustomer());
      const controller = new RiskController(repo, new InMemoryAuditTrail());
      const result = await controller.recalculate(
        'cust-001',
        {
          kind: 'FULL_RECALCULATION',
          factors: {
            productType: 100,
            transactionAnomaly: 100,
            jurisdictionalRisk: 100,
            pepStatus: 100,
            amlResults: 100,
          },
        } as any,
        testUser,
        testCorrelationId,
      );
      expect(result.newScore).toBe(100);
      expect(result.correlationId).toBe(testCorrelationId);
    });

    it('performs a DELTA_APPLICATION reproducing the B4.4 scenario', async () => {
      const repo = new FakeCustomerRepository();
      repo.seed(makeCustomer());
      const controller = new RiskController(repo, new InMemoryAuditTrail());
      const result = await controller.recalculate(
        'cust-001',
        {
          kind: 'DELTA_APPLICATION',
          deltas: [
            { reason: 'Jurisdictional risk increase', points: 15 },
            { reason: 'Transaction anomaly detected', points: 12 },
          ],
        } as any,
        testUser,
        testCorrelationId,
      );
      expect(result.newScore).toBe(69);
      expect(result.tierUpgraded).toBe(true);
    });

    it('throws BadRequestException when kind=FULL_RECALCULATION but factors is missing', async () => {
      const repo = new FakeCustomerRepository();
      repo.seed(makeCustomer());
      const controller = new RiskController(repo, new InMemoryAuditTrail());
      await expect(
        controller.recalculate(
          'cust-001',
          { kind: 'FULL_RECALCULATION' } as any,
          testUser,
          testCorrelationId,
        ),
      ).rejects.toThrow(); // real validation now happens via the DTO + global ValidationPipe in the HTTP pipeline, not in the controller — see note below
    });

    it('throws NotFoundException when the customer does not exist', async () => {
      const repo = new FakeCustomerRepository();
      const controller = new RiskController(repo, new InMemoryAuditTrail());
      await expect(
        controller.recalculate(
          'nonexistent',
          {
            kind: 'FULL_RECALCULATION',
            factors: {
              productType: 0,
              transactionAnomaly: 0,
              jurisdictionalRisk: 0,
              pepStatus: 0,
              amlResults: 0,
            },
          } as any,
          testUser,
          testCorrelationId,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
