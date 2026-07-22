// src/application/use-cases/escalate-kyc-tier.use-case.spec.ts
import {
  EscalateKycTierUseCase,
  EscalationRequestNotFoundError,
  InvalidEscalationTargetError,
} from './escalate-kyc-tier.use-case';
import { InMemoryAuditTrail } from '../../infrastructure/audit/in-memory-audit-trail';
import { Customer } from '../../domain/entities/customer.entity';
import { VerificationRequest } from '../../domain/entities/verification-request.entity';
import { CustomerRepositoryPort } from '../ports/customer-repository.port';
import { VerificationRequestRepositoryPort } from '../ports/verification-request-repository.port';
import { KycTier } from '../../domain/value-objects/kyc-tier.enum';
import { VerificationStatus } from '../../domain/value-objects/verification-status.enum';
import { RiskScore } from '../../domain/value-objects/risk-score.vo';
import { AuditActorType } from '../../domain/entities/audit-event.entity';
import { it, expect, describe } from '@jest/globals';

class FakeCustomerRepo implements CustomerRepositoryPort {
  private map = new Map<string, Customer>();
  seed(c: Customer) {
    this.map.set(c.customerId, c);
  }
  async save(c: Customer) {
    this.map.set(c.customerId, c);
  }
  async findById(id: string) {
    return this.map.get(id) ?? null;
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

class FakeRequestRepo implements VerificationRequestRepositoryPort {
  private map = new Map<string, VerificationRequest>();
  seed(r: VerificationRequest) {
    this.map.set(r.requestId, r);
  }
  async save(r: VerificationRequest) {
    this.map.set(r.requestId, r);
  }
  async findById(id: string) {
    return this.map.get(id) ?? null;
  }
  async findLatestForCustomer() {
    return null;
  }
  async findExpiring() {
    return [];
  }
}

function makeCustomer(tier = KycTier.MINIMUM): Customer {
  return Customer.create({
    customerId: 'cust-001',
    externalId: 'ext-001',
    fullNameEncrypted: Buffer.from('x'),
    dateOfBirthEncrypted: Buffer.from('x'),
    kycTier: tier,
    kycStatus: VerificationStatus.VERIFICATION_IN_PROGRESS,
    riskScore: RiskScore.create(20),
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

function makeRequest(tier = KycTier.MINIMUM): VerificationRequest {
  return VerificationRequest.reconstitute({
    requestId: 'req-001',
    customerId: 'cust-001',
    tier,
    workflowConfigVersion: '1.0.0',
    currentStep: null,
    status: VerificationStatus.VERIFICATION_IN_PROGRESS,
    initiatedBy: 'system',
    createdAt: new Date(),
    completedAt: null,
    expiresAt: new Date(Date.now() + 60000),
    retryOf: null,
  });
}

const actorFields = {
  actorId: 'ops-001',
  actorType: AuditActorType.USER,
  correlationId: 'corr-001',
};

describe('EscalateKycTierUseCase', () => {
  it('throws EscalationRequestNotFoundError for an unknown request', async () => {
    const useCase = new EscalateKycTierUseCase(
      new FakeRequestRepo(),
      new FakeCustomerRepo(),
      new InMemoryAuditTrail(),
    );
    await expect(
      useCase.execute({
        requestId: 'nonexistent',
        targetTier: KycTier.FULL,
        reason: 'x',
        ...actorFields,
      }),
    ).rejects.toBeInstanceOf(EscalationRequestNotFoundError);
  });

  it('rejects escalation to a lower or equal tier', async () => {
    const requestRepo = new FakeRequestRepo();
    requestRepo.seed(makeRequest(KycTier.FULL));
    const customerRepo = new FakeCustomerRepo();
    customerRepo.seed(makeCustomer(KycTier.FULL));
    const useCase = new EscalateKycTierUseCase(requestRepo, customerRepo, new InMemoryAuditTrail());
    await expect(
      useCase.execute({
        requestId: 'req-001',
        targetTier: KycTier.MINIMUM,
        reason: 'x',
        ...actorFields,
      }),
    ).rejects.toBeInstanceOf(InvalidEscalationTargetError);
  });

  it('escalates MINIMUM to EDD and upgrades the customer tier', async () => {
    const requestRepo = new FakeRequestRepo();
    requestRepo.seed(makeRequest(KycTier.MINIMUM));
    const customerRepo = new FakeCustomerRepo();
    customerRepo.seed(makeCustomer(KycTier.MINIMUM));
    const useCase = new EscalateKycTierUseCase(requestRepo, customerRepo, new InMemoryAuditTrail());
    const result = await useCase.execute({
      requestId: 'req-001',
      targetTier: KycTier.EDD,
      reason: 'Business compliance judgment call requiring enhanced review',
      ...actorFields,
    });
    expect(result.previousTier).toBe(KycTier.MINIMUM);
    expect(result.newTier).toBe(KycTier.EDD);
    const reloaded = await customerRepo.findById('cust-001');
    expect(reloaded!.kycTier).toBe(KycTier.EDD);
  });

  it('records a ManualTierEscalation audit event with the reason', async () => {
    const requestRepo = new FakeRequestRepo();
    requestRepo.seed(makeRequest(KycTier.MINIMUM));
    const customerRepo = new FakeCustomerRepo();
    customerRepo.seed(makeCustomer(KycTier.MINIMUM));
    const auditTrail = new InMemoryAuditTrail();
    const useCase = new EscalateKycTierUseCase(requestRepo, customerRepo, auditTrail);
    await useCase.execute({
      requestId: 'req-001',
      targetTier: KycTier.FULL,
      reason: 'Customer requested manual review',
      ...actorFields,
    });
    const events = auditTrail.getEventsForCustomer('cust-001');
    expect(events[0].toProps().eventType).toBe('ManualTierEscalation');
    expect(events[0].toProps().eventPayload.reason).toBe('Customer requested manual review');
  });
});
