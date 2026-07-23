// src/application/use-cases/request-data-erasure.use-case.spec.ts
import {
  DataErasureCustomerNotFoundError,
  RequestDataErasureUseCase,
} from './request-data-erasure.use-case';
import { InMemoryAuditTrail } from '../../infrastructure/audit/in-memory-audit-trail';
import { InMemoryDataErasureRepository } from '../../infrastructure/persistence/in-memory-data-erasure-repository';
import { InMemoryTimerRepository } from '../../infrastructure/persistence/in-memory-timer-repository';
import { TimerService } from '../workflow-engine/timer.service';
import { TimerType } from '../ports/timer-repository.port';
import { Customer } from '../../domain/entities/customer.entity';
import { CustomerRepositoryPort } from '../ports/customer-repository.port';
import { KycTier } from '../../domain/value-objects/kyc-tier.enum';
import { VerificationStatus } from '../../domain/value-objects/verification-status.enum';
import { RiskScore } from '../../domain/value-objects/risk-score.vo';
import { AuditActorType } from '../../domain/entities/audit-event.entity';
import { DataCategory } from '../../domain/data-erasure/data-category';
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

function makeCustomer(): Customer {
  return Customer.create({
    customerId: 'cust-001',
    externalId: 'ext-001',
    fullNameEncrypted: Buffer.from('original-encrypted-name'),
    dateOfBirthEncrypted: Buffer.from('original-encrypted-dob'),
    kycTier: KycTier.FULL,
    kycStatus: VerificationStatus.VERIFIED,
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

function makeUseCase(customerRepo: FakeCustomerRepo) {
  return new RequestDataErasureUseCase(
    customerRepo,
    new InMemoryDataErasureRepository(),
    new InMemoryAuditTrail(),
    new TimerService(new InMemoryTimerRepository()),
  );
}

const actorFields = {
  actorId: 'system',
  actorType: AuditActorType.SYSTEM,
  correlationId: 'corr-001',
  requestorId: 'cust-001',
};

describe('RequestDataErasureUseCase', () => {
  it('throws DataErasureCustomerNotFoundError for an unknown customer', async () => {
    const useCase = makeUseCase(new FakeCustomerRepo());
    await expect(
      useCase.execute({
        customerId: 'nonexistent',
        relationshipEndDate: null,
        hasActiveLoans: false,
        hasOpenInvestigations: false,
        hasPendingLitigation: false,
        ...actorFields,
      }),
    ).rejects.toBeInstanceOf(DataErasureCustomerNotFoundError);
  });

  describe('Scenario B4.3 reproduction — loan closed 18 months ago', () => {
    it('identifies exactly one active hold (PMLA), with ~3.5 years remaining', async () => {
      const repo = new FakeCustomerRepo();
      repo.seed(makeCustomer());
      const useCase = makeUseCase(repo);
      const eighteenMonthsAgo = new Date();
      eighteenMonthsAgo.setMonth(eighteenMonthsAgo.getMonth() - 18);

      const result = await useCase.execute({
        customerId: 'cust-001',
        relationshipEndDate: eighteenMonthsAgo,
        hasActiveLoans: false,
        hasOpenInvestigations: false,
        hasPendingLitigation: false,
        ...actorFields,
      });

      expect(result.legalHolds).toHaveLength(1);
      expect(result.legalHolds[0].holdType).toBe('PMLA');
      const remainingYears =
        (result.scheduledCompletionDate!.getTime() - Date.now()) / (365.25 * 24 * 60 * 60 * 1000);
      expect(remainingYears).toBeGreaterThan(3.3);
      expect(remainingYears).toBeLessThan(3.7);
    });

    it('categorises marketing/communication/behavioural/supplementary as eligible, KYC/audit as retained', async () => {
      const repo = new FakeCustomerRepo();
      repo.seed(makeCustomer());
      const useCase = makeUseCase(repo);
      const eighteenMonthsAgo = new Date();
      eighteenMonthsAgo.setMonth(eighteenMonthsAgo.getMonth() - 18);

      const result = await useCase.execute({
        customerId: 'cust-001',
        relationshipEndDate: eighteenMonthsAgo,
        hasActiveLoans: false,
        hasOpenInvestigations: false,
        hasPendingLitigation: false,
        ...actorFields,
      });

      expect(result.eligibleDataCategories).toContain(DataCategory.MARKETING_PREFERENCES);
      expect(result.retainedDataCategories).toContain(DataCategory.KYC_DOCUMENTS);
      expect(result.retainedDataCategories).toContain(DataCategory.AUDIT_EVENTS);
    });

    it('results in PARTIALLY_EXECUTED status, not COMPLETED or REJECTED', async () => {
      const repo = new FakeCustomerRepo();
      repo.seed(makeCustomer());
      const useCase = makeUseCase(repo);
      const eighteenMonthsAgo = new Date();
      eighteenMonthsAgo.setMonth(eighteenMonthsAgo.getMonth() - 18);

      const result = await useCase.execute({
        customerId: 'cust-001',
        relationshipEndDate: eighteenMonthsAgo,
        hasActiveLoans: false,
        hasOpenInvestigations: false,
        hasPendingLitigation: false,
        ...actorFields,
      });
      expect(result.status).toBe('PARTIALLY_EXECUTED');
    });

    it('does NOT anonymise the customer entity while a PMLA hold is active', async () => {
      const repo = new FakeCustomerRepo();
      const customer = makeCustomer();
      repo.seed(customer);
      const useCase = makeUseCase(repo);
      const eighteenMonthsAgo = new Date();
      eighteenMonthsAgo.setMonth(eighteenMonthsAgo.getMonth() - 18);

      await useCase.execute({
        customerId: 'cust-001',
        relationshipEndDate: eighteenMonthsAgo,
        hasActiveLoans: false,
        hasOpenInvestigations: false,
        hasPendingLitigation: false,
        ...actorFields,
      });
      const reloaded = await repo.findById('cust-001');
      expect(
        reloaded!.toProps().fullNameEncrypted.equals(Buffer.from('original-encrypted-name')),
      ).toBe(true);
    });

    it('schedules a DATA_ERASURE_DUE timer at the PMLA expiry date', async () => {
      const repo = new FakeCustomerRepo();
      repo.seed(makeCustomer());
      const timerRepo = new InMemoryTimerRepository();
      const useCase = new RequestDataErasureUseCase(
        repo,
        new InMemoryDataErasureRepository(),
        new InMemoryAuditTrail(),
        new TimerService(timerRepo),
      );
      const eighteenMonthsAgo = new Date();
      eighteenMonthsAgo.setMonth(eighteenMonthsAgo.getMonth() - 18);

      await useCase.execute({
        customerId: 'cust-001',
        relationshipEndDate: eighteenMonthsAgo,
        hasActiveLoans: false,
        hasOpenInvestigations: false,
        hasPendingLitigation: false,
        ...actorFields,
      });
      const timers = await timerRepo.findByCustomerAndType('cust-001', TimerType.DATA_ERASURE_DUE);
      expect(timers).toHaveLength(1);
    });

    it('generates a customer response covering what was anonymised, what is retained with legal basis, and when', async () => {
      const repo = new FakeCustomerRepo();
      repo.seed(makeCustomer());
      const useCase = makeUseCase(repo);
      const eighteenMonthsAgo = new Date();
      eighteenMonthsAgo.setMonth(eighteenMonthsAgo.getMonth() - 18);

      const result = await useCase.execute({
        customerId: 'cust-001',
        relationshipEndDate: eighteenMonthsAgo,
        hasActiveLoans: false,
        hasOpenInvestigations: false,
        hasPendingLitigation: false,
        ...actorFields,
      });
      expect(result.customerResponse).toContain('PMLA');
      expect(result.customerResponse).toContain('Grievance Officer');
      expect(result.customerResponse).toMatch(/scheduled for erasure/);
    });
  });

  describe('full erasure — no active holds', () => {
    it('anonymises the customer entity and returns COMPLETED status', async () => {
      const repo = new FakeCustomerRepo();
      repo.seed(makeCustomer());
      const useCase = makeUseCase(repo);
      const result = await useCase.execute({
        customerId: 'cust-001',
        relationshipEndDate: null,
        hasActiveLoans: false,
        hasOpenInvestigations: false,
        hasPendingLitigation: false,
        ...actorFields,
      });
      expect(result.status).toBe('COMPLETED');
      const reloaded = await repo.findById('cust-001');
      expect(
        reloaded!.toProps().fullNameEncrypted.equals(Buffer.from('original-encrypted-name')),
      ).toBe(false);
    });

    it('sets no scheduled completion date for a full, immediate erasure', async () => {
      const repo = new FakeCustomerRepo();
      repo.seed(makeCustomer());
      const useCase = makeUseCase(repo);
      const result = await useCase.execute({
        customerId: 'cust-001',
        relationshipEndDate: null,
        hasActiveLoans: false,
        hasOpenInvestigations: false,
        hasPendingLitigation: false,
        ...actorFields,
      });
      expect(result.scheduledCompletionDate).toBeNull();
    });
  });

  describe('indefinite hold — active loan, no PMLA clock started', () => {
    it('results in PARTIALLY_EXECUTED with no scheduled completion date', async () => {
      const repo = new FakeCustomerRepo();
      repo.seed(makeCustomer());
      const useCase = makeUseCase(repo);
      const result = await useCase.execute({
        customerId: 'cust-001',
        relationshipEndDate: null,
        hasActiveLoans: true,
        hasOpenInvestigations: false,
        hasPendingLitigation: false,
        ...actorFields,
      });
      expect(result.status).toBe('PARTIALLY_EXECUTED');
      expect(result.scheduledCompletionDate).toBeNull();
    });

    it('does not schedule a DATA_ERASURE_DUE timer for an indefinite hold', async () => {
      const repo = new FakeCustomerRepo();
      repo.seed(makeCustomer());
      const timerRepo = new InMemoryTimerRepository();
      const useCase = new RequestDataErasureUseCase(
        repo,
        new InMemoryDataErasureRepository(),
        new InMemoryAuditTrail(),
        new TimerService(timerRepo),
      );
      await useCase.execute({
        customerId: 'cust-001',
        relationshipEndDate: null,
        hasActiveLoans: true,
        hasOpenInvestigations: false,
        hasPendingLitigation: false,
        ...actorFields,
      });
      const timers = await timerRepo.findByCustomerAndType('cust-001', TimerType.DATA_ERASURE_DUE);
      expect(timers).toHaveLength(0);
    });
  });

  describe('audit trail', () => {
    it('records both DataErasureRequested and DataErasureExecuted events, correctly hash-chained', async () => {
      const repo = new FakeCustomerRepo();
      repo.seed(makeCustomer());
      const auditTrail = new InMemoryAuditTrail();
      const useCase = new RequestDataErasureUseCase(
        repo,
        new InMemoryDataErasureRepository(),
        auditTrail,
        new TimerService(new InMemoryTimerRepository()),
      );
      await useCase.execute({
        customerId: 'cust-001',
        relationshipEndDate: null,
        hasActiveLoans: false,
        hasOpenInvestigations: false,
        hasPendingLitigation: false,
        ...actorFields,
      });
      const events = auditTrail.getEventsForCustomer('cust-001');
      expect(events.map((e) => e.toProps().eventType)).toEqual([
        'DataErasureRequested',
        'DataErasureExecuted',
      ]);
      expect(events[1].previousEventHash).toBe(events[0].eventHash);
    });
  });

  describe('persistence', () => {
    it('persists the erasure request record with all fields populated', async () => {
      const repo = new FakeCustomerRepo();
      repo.seed(makeCustomer());
      const erasureRepo = new InMemoryDataErasureRepository();
      const useCase = new RequestDataErasureUseCase(
        repo,
        erasureRepo,
        new InMemoryAuditTrail(),
        new TimerService(new InMemoryTimerRepository()),
      );
      const result = await useCase.execute({
        customerId: 'cust-001',
        relationshipEndDate: null,
        hasActiveLoans: false,
        hasOpenInvestigations: false,
        hasPendingLitigation: false,
        ...actorFields,
      });
      const record = await erasureRepo.findById(result.requestId);
      expect(record).not.toBeNull();
      expect(record!.status).toBe('COMPLETED');
    });
  });
});
