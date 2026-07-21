// src/application/use-cases/process-webhook.use-case.spec.ts
import { ProcessWebhookUseCase, WebhookRequestNotFoundError } from './process-webhook.use-case';
import { WorkflowConfigProvider } from './initiate-kyc.use-case';
import { InMemoryAuditTrail } from '../../infrastructure/audit/in-memory-audit-trail';
import { InMemoryNotification } from '../../infrastructure/notification/in-memory-notification';
import { InMemoryTimerRepository } from '../../infrastructure/persistence/in-memory-timer-repository';
import { TimerService } from '../workflow-engine/timer.service';
import { TimerType } from '../ports/timer-repository.port';
import { VendorAdapterFactory } from '../../infrastructure/vendors/vendor-adapter.factory';
import { Customer } from '../../domain/entities/customer.entity';
import { VerificationRequest } from '../../domain/entities/verification-request.entity';
import { CustomerRepositoryPort } from '../ports/customer-repository.port';
import { VerificationRequestRepositoryPort } from '../ports/verification-request-repository.port';
import { KycTier } from '../../domain/value-objects/kyc-tier.enum';
import { VerificationStatus } from '../../domain/value-objects/verification-status.enum';
import { RiskScore } from '../../domain/value-objects/risk-score.vo';
import { VendorType } from '../ports/kyc-vendor.port';
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

function makeCustomer(): Customer {
  return Customer.create({
    customerId: 'cust-001',
    externalId: 'ext-001',
    fullNameEncrypted: Buffer.from('x'),
    dateOfBirthEncrypted: Buffer.from('x'),
    kycTier: KycTier.EDD,
    kycStatus: VerificationStatus.VENDOR_CALLBACK_AWAITED,
    riskScore: RiskScore.create(65),
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

function makeRequest(): VerificationRequest {
  return VerificationRequest.reconstitute({
    requestId: 'req-001',
    customerId: 'cust-001',
    tier: KycTier.EDD,
    workflowConfigVersion: '1.0.0',
    currentStep: 'video-kyc-session',
    status: VerificationStatus.VENDOR_CALLBACK_AWAITED,
    initiatedBy: 'system',
    createdAt: new Date(),
    completedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    retryOf: null,
  });
}

function makeConfigProvider(): WorkflowConfigProvider {
  return {
    getConfig: () => ({
      tier: KycTier.EDD,
      description: 't',
      targetCompletionMinutes: 2880,
      approvalAuthority: 'MANDATORY_COMPLIANCE_REVIEW',
      requiredDocuments: [],
      steps: [
        {
          stepName: 'full-aml-screen',
          vendorType: VendorType.AML_SCREENING,
          order: 1,
          parallelGroup: null,
          guardExpression: null,
          timeoutSeconds: 5,
        },
      ],
      ckycUpload: { timing: 'IMMEDIATE_POST_APPROVAL', deadlineDays: 0 },
      reVerification: { frequency: 'QUARTERLY_AND_TRIGGER_BASED' },
      documentRetentionYears: 10,
      ongoingMonitoring: 'FULL',
    }),
  };
}

function makeUseCase(deps: {
  customerRepo: FakeCustomerRepo;
  requestRepo: FakeRequestRepo;
  videoKycAdapter?: any;
  amlAdapter?: any;
  timerRepo?: InMemoryTimerRepository;
}) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const videoKyc = deps.videoKycAdapter ?? {
    handleCallback: jest.fn().mockResolvedValue({
      processed: true,
      wasDuplicate: false,
      result: { vendorReferenceId: 'sess-1', success: true, normalisedData: {} },
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const aml = deps.amlAdapter ?? {
    initiateVerification: jest
      .fn()
      .mockResolvedValue({ vendorReferenceId: 'ref-2', isAsync: false }),
    fetchResult: jest
      .fn()
      .mockResolvedValue({ vendorReferenceId: 'ref-2', success: true, normalisedData: {} }),
  };
  const vendorFactory = {
    getAdapter: jest.fn((type: VendorType) => (type === VendorType.VIDEO_KYC ? videoKyc : aml)),
  } as unknown as VendorAdapterFactory;
  const timerRepo = deps.timerRepo ?? new InMemoryTimerRepository();
  return new ProcessWebhookUseCase(
    deps.customerRepo,
    deps.requestRepo,
    new InMemoryAuditTrail(),
    new InMemoryNotification(),
    makeConfigProvider(),
    vendorFactory,
    new TimerService(timerRepo),
  );
}

describe('ProcessWebhookUseCase', () => {
  it('throws WebhookRequestNotFoundError for an unknown requestId', async () => {
    const useCase = makeUseCase({
      customerRepo: new FakeCustomerRepo(),
      requestRepo: new FakeRequestRepo(),
    });
    await expect(
      useCase.execute({
        vendorType: VendorType.VIDEO_KYC,
        requestId: 'nonexistent',
        payload: {} as any,
        actorId: 'x',
        correlationId: 'y',
      }),
    ).rejects.toBeInstanceOf(WebhookRequestNotFoundError);
  });

  it('returns wasDuplicate=true and does not touch state for a duplicate webhook', async () => {
    const customerRepo = new FakeCustomerRepo();
    customerRepo.seed(makeCustomer());
    const requestRepo = new FakeRequestRepo();
    requestRepo.seed(makeRequest());
    const dupAdapter = {
      handleCallback: jest.fn().mockResolvedValue({ processed: true, wasDuplicate: true }),
    };
    const useCase = makeUseCase({ customerRepo, requestRepo, videoKycAdapter: dupAdapter });
    const result = await useCase.execute({
      vendorType: VendorType.VIDEO_KYC,
      requestId: 'req-001',
      payload: {} as any,
      actorId: 'x',
      correlationId: 'y',
    });
    expect(result.wasDuplicate).toBe(true);
    expect(result.requestStatus).toBeNull();
    const reloaded = await requestRepo.findById('req-001');
    expect(reloaded!.status).toBe(VerificationStatus.VENDOR_CALLBACK_AWAITED); // unchanged
  });

  it('resumes workflow and reaches VERIFIED on a successful callback with all remaining steps passing', async () => {
    const customerRepo = new FakeCustomerRepo();
    customerRepo.seed(makeCustomer());
    const requestRepo = new FakeRequestRepo();
    requestRepo.seed(makeRequest());
    const useCase = makeUseCase({ customerRepo, requestRepo });
    const result = await useCase.execute({
      vendorType: VendorType.VIDEO_KYC,
      requestId: 'req-001',
      payload: {} as any,
      actorId: 'system',
      correlationId: 'corr-001',
    });
    expect(result.requestStatus).toBe(VerificationStatus.VERIFIED);
  });

  it('reaches ESCALATED_TO_MANUAL when the resumed workflow hits a manual step', async () => {
    const configProvider: WorkflowConfigProvider = {
      getConfig: () => ({
        ...makeConfigProvider().getConfig(KycTier.EDD),
        steps: [
          {
            stepName: 'compliance-review',
            vendorType: null,
            order: 1,
            parallelGroup: null,
            guardExpression: null,
            timeoutSeconds: null,
            isManualStep: true,
          },
        ],
      }),
    };
    const customerRepo = new FakeCustomerRepo();
    customerRepo.seed(makeCustomer());
    const requestRepo = new FakeRequestRepo();
    requestRepo.seed(makeRequest());
    const videoKyc = {
      handleCallback: jest.fn().mockResolvedValue({
        processed: true,
        wasDuplicate: false,
        result: { vendorReferenceId: 'sess-1', success: true, normalisedData: {} },
      }),
    };
    const vendorFactory = {
      getAdapter: jest.fn().mockReturnValue(videoKyc),
    } as unknown as VendorAdapterFactory;
    const useCase = new ProcessWebhookUseCase(
      customerRepo,
      requestRepo,
      new InMemoryAuditTrail(),
      new InMemoryNotification(),
      configProvider,
      vendorFactory,
      new TimerService(new InMemoryTimerRepository()),
    );
    const result = await useCase.execute({
      vendorType: VendorType.VIDEO_KYC,
      requestId: 'req-001',
      payload: {} as any,
      actorId: 'system',
      correlationId: 'corr-001',
    });
    expect(result.requestStatus).toBe(VerificationStatus.ESCALATED_TO_MANUAL);
  });

  it('reaches REJECTED when the callback itself reports failure (e.g. session.failed)', async () => {
    const customerRepo = new FakeCustomerRepo();
    customerRepo.seed(makeCustomer());
    const requestRepo = new FakeRequestRepo();
    requestRepo.seed(makeRequest());
    const failedAdapter = {
      handleCallback: jest.fn().mockResolvedValue({
        processed: true,
        wasDuplicate: false,
        result: {
          vendorReferenceId: 'sess-1',
          success: false,
          normalisedData: {},
          vendorErrorCode: 'liveness-failed',
        },
      }),
    };
    const useCase = makeUseCase({ customerRepo, requestRepo, videoKycAdapter: failedAdapter });
    const result = await useCase.execute({
      vendorType: VendorType.VIDEO_KYC,
      requestId: 'req-001',
      payload: {} as any,
      actorId: 'system',
      correlationId: 'corr-001',
    });
    expect(result.requestStatus).toBe(VerificationStatus.REJECTED);
  });

  it('cancels the pending VENDOR_CALLBACK_TIMEOUT timer on a successful, non-duplicate callback', async () => {
    const customerRepo = new FakeCustomerRepo();
    customerRepo.seed(makeCustomer());
    const requestRepo = new FakeRequestRepo();
    requestRepo.seed(makeRequest());
    const timerRepo = new InMemoryTimerRepository();
    const timerService = new TimerService(timerRepo);
    await timerService.scheduleFixedTimer({
      timerType: TimerType.VENDOR_CALLBACK_TIMEOUT,
      customerId: 'cust-001',
    });
    const useCase = makeUseCase({ customerRepo, requestRepo, timerRepo });
    await useCase.execute({
      vendorType: VendorType.VIDEO_KYC,
      requestId: 'req-001',
      payload: {} as any,
      actorId: 'system',
      correlationId: 'corr-001',
    });
    const stillDue = await timerRepo.findDue(new Date(Date.now() + 73 * 60 * 60 * 1000));
    expect(stillDue).toHaveLength(0); // cancelled, not fired
  });

  it('persists the final status on both request and customer', async () => {
    const customerRepo = new FakeCustomerRepo();
    customerRepo.seed(makeCustomer());
    const requestRepo = new FakeRequestRepo();
    requestRepo.seed(makeRequest());
    const useCase = makeUseCase({ customerRepo, requestRepo });
    await useCase.execute({
      vendorType: VendorType.VIDEO_KYC,
      requestId: 'req-001',
      payload: {} as any,
      actorId: 'system',
      correlationId: 'corr-001',
    });
    const reloadedCustomer = await customerRepo.findById('cust-001');
    expect(reloadedCustomer!.kycStatus).toBe(VerificationStatus.VERIFIED);
  });
});
