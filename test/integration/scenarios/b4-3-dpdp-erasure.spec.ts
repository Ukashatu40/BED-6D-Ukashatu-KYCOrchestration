// test/integration/scenarios/b4-3-dpdp-erasure.spec.ts
import { RequestDataErasureUseCase } from '../../../src/application/use-cases/request-data-erasure.use-case';
import { InMemoryAuditTrail } from '../../../src/infrastructure/audit/in-memory-audit-trail';
import { InMemoryDataErasureRepository } from '../../../src/infrastructure/persistence/in-memory-data-erasure-repository';
import { InMemoryTimerRepository } from '../../../src/infrastructure/persistence/in-memory-timer-repository';
import { TimerService } from '../../../src/application/workflow-engine/timer.service';
import { TimerType } from '../../../src/application/ports/timer-repository.port';
import { Customer } from '../../../src/domain/entities/customer.entity';
import { CustomerRepositoryPort } from '../../../src/application/ports/customer-repository.port';
import { KycTier } from '../../../src/domain/value-objects/kyc-tier.enum';
import { VerificationStatus } from '../../../src/domain/value-objects/verification-status.enum';
import { RiskScore } from '../../../src/domain/value-objects/risk-score.vo';
import { AuditActorType } from '../../../src/domain/entities/audit-event.entity';
import { DataCategory } from '../../../src/domain/data-erasure/data-category';
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
 * Reproduces Section B4.3 exactly: a customer whose personal loan was
 * fully repaid 18 months ago submits a DPDP Section 8(7) erasure request
 * demanding all personal data be "deleted from your systems permanently."
 * The spec's own walkthrough establishes: (a) the PMLA 5-year retention
 * has NOT expired (3 years 6 months remain), (b) no other holds apply,
 * (c) full erasure is therefore legally prohibited, but (d) certain
 * non-PMLA categories CAN and must be anonymised immediately, with (e) a
 * scheduled future completion and (f) a transparent customer response
 * explaining exactly what was erased, what was retained and why, and
 * when the rest will be erased.
 *
 * Every one of those six sub-requirements gets its own assertion below —
 * this is the one scenario in the spec's Part C.4 with the most explicit,
 * checkable structure, so the test suite mirrors that structure directly
 * rather than collapsing it into a single end-to-end assertion.
 */
describe('Scenario B4.3 — DPDP Erasure Request', () => {
  const actorFields = {
    actorId: 'system',
    actorType: AuditActorType.SYSTEM,
    correlationId: 'corr-b43',
    requestorId: 'cust-b43',
  };

  function makeCustomerWithClosedLoan(): Customer {
    return Customer.create({
      customerId: 'cust-b43',
      externalId: 'ext-b43',
      fullNameEncrypted: Buffer.from('original-encrypted-name'),
      dateOfBirthEncrypted: Buffer.from('original-encrypted-dob'),
      kycTier: KycTier.FULL,
      kycStatus: VerificationStatus.VERIFIED,
      riskScore: RiskScore.create(15),
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

  function eighteenMonthsAgo(): Date {
    const d = new Date();
    d.setMonth(d.getMonth() - 18);
    return d;
  }

  function makeUseCase(
    customerRepo: InMemoryCustomerRepo,
    timerRepo = new InMemoryTimerRepository(),
    auditTrail = new InMemoryAuditTrail(),
  ) {
    return new RequestDataErasureUseCase(
      customerRepo,
      new InMemoryDataErasureRepository(),
      auditTrail,
      new TimerService(timerRepo),
    );
  }

  it('(a) evaluates the PMLA 5-year retention as not yet expired, with approximately 3.5 years remaining', async () => {
    const customerRepo = new InMemoryCustomerRepo();
    customerRepo.seed(makeCustomerWithClosedLoan());
    const useCase = makeUseCase(customerRepo);

    const result = await useCase.execute({
      customerId: 'cust-b43',
      relationshipEndDate: eighteenMonthsAgo(),
      hasActiveLoans: false,
      hasOpenInvestigations: false,
      hasPendingLitigation: false,
      ...actorFields,
    });

    const pmlaHold = result.legalHolds.find((h) => h.holdType === 'PMLA');
    expect(pmlaHold).toBeDefined();
    const remainingYears =
      (pmlaHold!.expiryDate!.getTime() - Date.now()) / (365.25 * 24 * 60 * 60 * 1000);
    expect(remainingYears).toBeGreaterThan(3.3);
    expect(remainingYears).toBeLessThan(3.7);
  });

  it('(b) finds no other active legal holds (no active loans, investigations, or litigation)', async () => {
    const customerRepo = new InMemoryCustomerRepo();
    customerRepo.seed(makeCustomerWithClosedLoan());
    const useCase = makeUseCase(customerRepo);

    const result = await useCase.execute({
      customerId: 'cust-b43',
      relationshipEndDate: eighteenMonthsAgo(),
      hasActiveLoans: false,
      hasOpenInvestigations: false,
      hasPendingLitigation: false,
      ...actorFields,
    });

    expect(result.legalHolds).toHaveLength(1); // PMLA only — nothing else
    expect(result.legalHolds.map((h) => h.holdType)).not.toContain('ACTIVE_LOAN');
    expect(result.legalHolds.map((h) => h.holdType)).not.toContain('INVESTIGATION');
    expect(result.legalHolds.map((h) => h.holdType)).not.toContain('LITIGATION');
  });

  it('(c) does NOT perform full erasure — core PII remains untouched given the active PMLA hold', async () => {
    const customerRepo = new InMemoryCustomerRepo();
    customerRepo.seed(makeCustomerWithClosedLoan());
    const useCase = makeUseCase(customerRepo);

    await useCase.execute({
      customerId: 'cust-b43',
      relationshipEndDate: eighteenMonthsAgo(),
      hasActiveLoans: false,
      hasOpenInvestigations: false,
      hasPendingLitigation: false,
      ...actorFields,
    });

    const reloaded = await customerRepo.findById('cust-b43');
    expect(
      reloaded!.toProps().fullNameEncrypted.equals(Buffer.from('original-encrypted-name')),
    ).toBe(true);
    expect(
      reloaded!.toProps().dateOfBirthEncrypted.equals(Buffer.from('original-encrypted-dob')),
    ).toBe(true);
  });

  it('(d) executes partial anonymisation — marketing/communication/behavioural/supplementary categories marked eligible, PMLA-required categories retained', async () => {
    const customerRepo = new InMemoryCustomerRepo();
    customerRepo.seed(makeCustomerWithClosedLoan());
    const useCase = makeUseCase(customerRepo);

    const result = await useCase.execute({
      customerId: 'cust-b43',
      relationshipEndDate: eighteenMonthsAgo(),
      hasActiveLoans: false,
      hasOpenInvestigations: false,
      hasPendingLitigation: false,
      ...actorFields,
    });

    expect(result.eligibleDataCategories).toEqual(
      expect.arrayContaining([
        DataCategory.MARKETING_PREFERENCES,
        DataCategory.COMMUNICATION_HISTORY,
        DataCategory.BEHAVIOURAL_DATA,
        DataCategory.SUPPLEMENTARY_DOCUMENTS,
      ]),
    );
    expect(result.retainedDataCategories).toEqual(
      expect.arrayContaining([
        DataCategory.KYC_DOCUMENTS,
        DataCategory.VERIFICATION_RECORDS,
        DataCategory.TRANSACTION_HISTORY,
        DataCategory.AML_SCREENING_RESULTS,
        DataCategory.AUDIT_EVENTS,
      ]),
    );
    expect(result.status).toBe('PARTIALLY_EXECUTED');
  });

  it('(e) creates a scheduled task to complete the remaining erasure when the PMLA hold expires', async () => {
    const customerRepo = new InMemoryCustomerRepo();
    customerRepo.seed(makeCustomerWithClosedLoan());
    const timerRepo = new InMemoryTimerRepository();
    const useCase = makeUseCase(customerRepo, timerRepo);

    const result = await useCase.execute({
      customerId: 'cust-b43',
      relationshipEndDate: eighteenMonthsAgo(),
      hasActiveLoans: false,
      hasOpenInvestigations: false,
      hasPendingLitigation: false,
      ...actorFields,
    });

    expect(result.scheduledCompletionDate).not.toBeNull();
    const timers = await timerRepo.findByCustomerAndType('cust-b43', TimerType.DATA_ERASURE_DUE);
    expect(timers).toHaveLength(1);
    expect(timers[0].fireAt.getTime()).toBe(result.scheduledCompletionDate!.getTime());
  });

  it('(f) sends the customer a detailed response covering what was anonymised, what is retained with legal basis, when the rest will be erased, and how to reach the Grievance Officer', async () => {
    const customerRepo = new InMemoryCustomerRepo();
    customerRepo.seed(makeCustomerWithClosedLoan());
    const useCase = makeUseCase(customerRepo);

    const result = await useCase.execute({
      customerId: 'cust-b43',
      relationshipEndDate: eighteenMonthsAgo(),
      hasActiveLoans: false,
      hasOpenInvestigations: false,
      hasPendingLitigation: false,
      ...actorFields,
    });

    expect(result.customerResponse).toMatch(/anonymised/i);
    expect(result.customerResponse).toContain('PMLA'); // legal basis for retention
    expect(result.customerResponse).toMatch(/scheduled for erasure/i);
    expect(result.customerResponse).toContain('Grievance Officer');
  });

  it('records the entire erasure lifecycle in the audit trail, correctly hash-chained', async () => {
    const customerRepo = new InMemoryCustomerRepo();
    customerRepo.seed(makeCustomerWithClosedLoan());
    const auditTrail = new InMemoryAuditTrail();
    const useCase = makeUseCase(customerRepo, new InMemoryTimerRepository(), auditTrail);

    await useCase.execute({
      customerId: 'cust-b43',
      relationshipEndDate: eighteenMonthsAgo(),
      hasActiveLoans: false,
      hasOpenInvestigations: false,
      hasPendingLitigation: false,
      ...actorFields,
    });

    const events = auditTrail.getEventsForCustomer('cust-b43');
    expect(events.map((e) => e.toProps().eventType)).toEqual([
      'DataErasureRequested',
      'DataErasureExecuted',
    ]);
    expect(events.every((e) => e.verifyOwnIntegrity())).toBe(true);
    expect(events[1].previousEventHash).toBe(events[0].eventHash);

    const executedEvent = events.find((e) => e.toProps().eventType === 'DataErasureExecuted')!;
    expect(executedEvent.toProps().eventPayload.legalHolds).toHaveLength(1);
  });

  it('end-to-end: the full B4.3 narrative produces internally consistent results across every field', async () => {
    // A single comprehensive pass tying together every sub-requirement,
    // as a safety net against the individual (a)-(f) tests passing in
    // isolation while some combination of fields is actually inconsistent
    // with the others (e.g. status says PARTIALLY_EXECUTED but
    // scheduledCompletionDate is null, which would be a real bug elsewhere
    // in the use case's branching logic).
    const customerRepo = new InMemoryCustomerRepo();
    customerRepo.seed(makeCustomerWithClosedLoan());
    const useCase = makeUseCase(customerRepo);

    const result = await useCase.execute({
      customerId: 'cust-b43',
      relationshipEndDate: eighteenMonthsAgo(),
      hasActiveLoans: false,
      hasOpenInvestigations: false,
      hasPendingLitigation: false,
      ...actorFields,
    });

    expect(result.status).toBe('PARTIALLY_EXECUTED');
    expect(result.legalHolds).toHaveLength(1);
    expect(result.scheduledCompletionDate).not.toBeNull();
    expect(result.eligibleDataCategories.length).toBeGreaterThan(0);
    expect(result.retainedDataCategories.length).toBeGreaterThan(0);
    expect(result.customerResponse.length).toBeGreaterThan(50); // substantive, not a stub message
  });
});
