// src/application/use-cases/initiate-kyc.use-case.spec.ts
import {
  CustomerNotFoundError,
  InitiateKycUseCase,
  WorkflowConfigProvider,
} from './initiate-kyc.use-case';
import { InMemoryAuditTrail } from '../../infrastructure/audit/in-memory-audit-trail';
import { InMemoryNotification } from '../../infrastructure/notification/in-memory-notification';
import { Customer } from '../../domain/entities/customer.entity';
import { VerificationRequest } from '../../domain/entities/verification-request.entity';
import { CustomerRepositoryPort } from '../ports/customer-repository.port';
import { VerificationRequestRepositoryPort } from '../ports/verification-request-repository.port';
import { KycTier } from '../../domain/value-objects/kyc-tier.enum';
import { VerificationStatus } from '../../domain/value-objects/verification-status.enum';
import { RiskScore } from '../../domain/value-objects/risk-score.vo';
import { AuditActorType } from '../../domain/entities/audit-event.entity';
import { DocumentType } from '../../domain/value-objects/document-type.enum';
import { expect, describe, it } from '@jest/globals';

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
  public saved: VerificationRequest[] = [];
  async save(r: VerificationRequest) {
    this.saved.push(r);
  }
  async findById() {
    return null;
  }
  async findLatestForCustomer() {
    return null;
  }
  async findExpiring() {
    return [];
  }
}

function makeCustomer(): Customer {
  return Customer.create({
    customerId: 'cust-001',
    externalId: 'ext-001',
    fullNameEncrypted: Buffer.from('x'),
    dateOfBirthEncrypted: Buffer.from('x'),
    kycTier: KycTier.MINIMUM,
    kycStatus: VerificationStatus.NOT_STARTED,
    riskScore: RiskScore.create(0),
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

function makeConfigProvider(hasDocuments = true): WorkflowConfigProvider {
  return {
    getConfig: () => ({
      tier: KycTier.MINIMUM,
      description: 't',
      targetCompletionMinutes: 5,
      approvalAuthority: 'AUTOMATED',
      requiredDocuments: hasDocuments
        ? [{ documentType: DocumentType.AADHAAR, mandatory: true }]
        : [],
      steps: [],
      ckycUpload: { timing: 'DEFERRED', deadlineDays: 10 },
      reVerification: { frequency: 'ANNUAL' },
      documentRetentionYears: 5,
      ongoingMonitoring: false,
    }),
  };
}

const actorFields = {
  actorId: 'system',
  actorType: AuditActorType.SYSTEM,
  correlationId: 'corr-001',
};

describe('InitiateKycUseCase', () => {
  it('throws CustomerNotFoundError for an unknown customer', async () => {
    const useCase = new InitiateKycUseCase(
      new FakeCustomerRepo(),
      new FakeRequestRepo(),
      new InMemoryAuditTrail(),
      new InMemoryNotification(),
      makeConfigProvider(),
    );
    await expect(
      useCase.execute({
        customerId: 'nonexistent',
        loanAmountInr: 30000,
        isPep: false,
        isHighRiskJurisdiction: false,
        ...actorFields,
      }),
    ).rejects.toBeInstanceOf(CustomerNotFoundError);
  });

  it('assigns MINIMUM tier for a small loan and reaches DOCUMENTS_PENDING', async () => {
    const customerRepo = new FakeCustomerRepo();
    customerRepo.seed(makeCustomer());
    const requestRepo = new FakeRequestRepo();
    const useCase = new InitiateKycUseCase(
      customerRepo,
      requestRepo,
      new InMemoryAuditTrail(),
      new InMemoryNotification(),
      makeConfigProvider(true),
    );
    const result = await useCase.execute({
      customerId: 'cust-001',
      loanAmountInr: 30000,
      isPep: false,
      isHighRiskJurisdiction: false,
      ...actorFields,
    });
    expect(result.tier).toBe(KycTier.MINIMUM);
    expect(result.status).toBe(VerificationStatus.DOCUMENTS_PENDING);
  });

  it('assigns EDD tier for a PEP', async () => {
    const customerRepo = new FakeCustomerRepo();
    customerRepo.seed(makeCustomer());
    const useCase = new InitiateKycUseCase(
      customerRepo,
      new FakeRequestRepo(),
      new InMemoryAuditTrail(),
      new InMemoryNotification(),
      makeConfigProvider(true),
    );
    const result = await useCase.execute({
      customerId: 'cust-001',
      loanAmountInr: 30000,
      isPep: true,
      isHighRiskJurisdiction: false,
      ...actorFields,
    });
    expect(result.tier).toBe(KycTier.EDD);
  });

  it('persists the VerificationRequest with the final state machine status', async () => {
    const customerRepo = new FakeCustomerRepo();
    customerRepo.seed(makeCustomer());
    const requestRepo = new FakeRequestRepo();
    const useCase = new InitiateKycUseCase(
      customerRepo,
      requestRepo,
      new InMemoryAuditTrail(),
      new InMemoryNotification(),
      makeConfigProvider(true),
    );
    await useCase.execute({
      customerId: 'cust-001',
      loanAmountInr: 30000,
      isPep: false,
      isHighRiskJurisdiction: false,
      ...actorFields,
    });
    expect(requestRepo.saved).toHaveLength(1);
    expect(requestRepo.saved[0].status).toBe(VerificationStatus.DOCUMENTS_PENDING);
  });

  it('updates the customer tier and mirrored kycStatus', async () => {
    const customerRepo = new FakeCustomerRepo();
    customerRepo.seed(makeCustomer());
    const useCase = new InitiateKycUseCase(
      customerRepo,
      new FakeRequestRepo(),
      new InMemoryAuditTrail(),
      new InMemoryNotification(),
      makeConfigProvider(true),
    );
    await useCase.execute({
      customerId: 'cust-001',
      loanAmountInr: 5_000_001,
      isPep: false,
      isHighRiskJurisdiction: false,
      ...actorFields,
    });
    const reloaded = await customerRepo.findById('cust-001');
    expect(reloaded!.kycTier).toBe(KycTier.EDD);
    expect(reloaded!.kycStatus).toBe(VerificationStatus.DOCUMENTS_PENDING);
  });

  it('records audit events for both state transitions (kyc.initiated, docs.requested)', async () => {
    const customerRepo = new FakeCustomerRepo();
    customerRepo.seed(makeCustomer());
    const auditTrail = new InMemoryAuditTrail();
    const useCase = new InitiateKycUseCase(
      customerRepo,
      new FakeRequestRepo(),
      auditTrail,
      new InMemoryNotification(),
      makeConfigProvider(true),
    );
    await useCase.execute({
      customerId: 'cust-001',
      loanAmountInr: 30000,
      isPep: false,
      isHighRiskJurisdiction: false,
      ...actorFields,
    });
    const events = auditTrail.getEventsForCustomer('cust-001');
    expect(events).toHaveLength(2);
  });
});
