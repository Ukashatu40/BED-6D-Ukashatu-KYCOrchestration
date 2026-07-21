// src/application/use-cases/upload-kyc-document.use-case.spec.ts
import {
  UploadDocumentCustomerNotFoundError,
  UploadKycDocumentUseCase,
  VerificationRequestNotFoundError,
} from './upload-kyc-document.use-case';
import { WorkflowConfigProvider } from './initiate-kyc.use-case';
import { InMemoryAuditTrail } from '../../infrastructure/audit/in-memory-audit-trail';
import { InMemoryNotification } from '../../infrastructure/notification/in-memory-notification';
import { InMemoryObjectStore } from '../../infrastructure/storage/in-memory-object-store';
import { InMemoryDocumentRepository } from '../../infrastructure/persistence/in-memory-document-repository';
import { InMemoryTimerRepository } from '../../infrastructure/persistence/in-memory-timer-repository';
import { DocumentStorageService } from '../../infrastructure/storage/document-storage.service';
import { EncryptionService } from '../../infrastructure/encryption/encryption.service';
import { InMemoryKms } from '../../infrastructure/encryption/in-memory-kms';
import { TimerService } from '../workflow-engine/timer.service';
import { VendorAdapterFactory } from '../../infrastructure/vendors/vendor-adapter.factory';
import { Customer } from '../../domain/entities/customer.entity';
import { VerificationRequest } from '../../domain/entities/verification-request.entity';
import { CustomerRepositoryPort } from '../ports/customer-repository.port';
import { VerificationRequestRepositoryPort } from '../ports/verification-request-repository.port';
import { KycTier } from '../../domain/value-objects/kyc-tier.enum';
import { VerificationStatus } from '../../domain/value-objects/verification-status.enum';
import { RiskScore } from '../../domain/value-objects/risk-score.vo';
import { AuditActorType } from '../../domain/entities/audit-event.entity';
import { DocumentType } from '../../domain/value-objects/document-type.enum';
import { VendorType } from '../ports/kyc-vendor.port';
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
    kycTier: KycTier.MINIMUM,
    kycStatus: VerificationStatus.DOCUMENTS_PENDING,
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

function makeRequest(): VerificationRequest {
  return VerificationRequest.reconstitute({
    requestId: 'req-001',
    customerId: 'cust-001',
    tier: KycTier.MINIMUM,
    workflowConfigVersion: '1.0.0',
    currentStep: null,
    status: VerificationStatus.DOCUMENTS_PENDING,
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
      tier: KycTier.MINIMUM,
      description: 't',
      targetCompletionMinutes: 5,
      approvalAuthority: 'AUTOMATED',
      requiredDocuments: [{ documentType: DocumentType.AADHAAR, mandatory: true }],
      steps: [
        {
          stepName: 'aadhaar-fetch',
          vendorType: VendorType.DIGILOCKER,
          order: 1,
          parallelGroup: null,
          guardExpression: null,
          timeoutSeconds: 30,
        },
        {
          stepName: 'name-screen',
          vendorType: VendorType.AML_SCREENING,
          order: 2,
          parallelGroup: null,
          guardExpression: null,
          timeoutSeconds: 5,
        },
      ],
      ckycUpload: { timing: 'DEFERRED', deadlineDays: 10 },
      reVerification: { frequency: 'ANNUAL' },
      documentRetentionYears: 5,
      ongoingMonitoring: false,
    }),
  };
}

function makeVendorFactory(overrides: { digilocker?: any; aml?: any } = {}): VendorAdapterFactory {
  const digilocker = overrides.digilocker ?? {
    initiateVerification: jest
      .fn()
      .mockResolvedValue({ vendorReferenceId: 'ref-1', isAsync: false }),
    fetchResult: jest
      .fn()
      .mockResolvedValue({ vendorReferenceId: 'ref-1', success: true, normalisedData: {} }),
  };
  const aml = overrides.aml ?? {
    initiateVerification: jest
      .fn()
      .mockResolvedValue({ vendorReferenceId: 'ref-2', isAsync: false }),
    fetchResult: jest
      .fn()
      .mockResolvedValue({ vendorReferenceId: 'ref-2', success: true, normalisedData: {} }),
  };
  return {
    getAdapter: jest.fn((type: VendorType) => (type === VendorType.DIGILOCKER ? digilocker : aml)),
  } as unknown as VendorAdapterFactory;
}

function makeUseCase(deps: {
  customerRepo: FakeCustomerRepo;
  requestRepo: FakeRequestRepo;
  vendorFactory?: VendorAdapterFactory;
}) {
  const documentRepo = new InMemoryDocumentRepository();
  const encryptionService = new EncryptionService(new InMemoryKms());
  const storage = new DocumentStorageService(
    encryptionService,
    new InMemoryObjectStore(),
    documentRepo,
    new InMemoryAuditTrail(),
  );
  const timerService = new TimerService(new InMemoryTimerRepository());
  return new UploadKycDocumentUseCase(
    deps.customerRepo,
    deps.requestRepo,
    documentRepo,
    storage,
    new InMemoryAuditTrail(),
    new InMemoryNotification(),
    makeConfigProvider(),
    deps.vendorFactory ?? makeVendorFactory(),
    timerService,
  );
}

const actorFields = {
  actorId: 'user-001',
  actorType: AuditActorType.USER,
  correlationId: 'corr-001',
};

describe('UploadKycDocumentUseCase', () => {
  it('throws VerificationRequestNotFoundError for an unknown request', async () => {
    const useCase = makeUseCase({
      customerRepo: new FakeCustomerRepo(),
      requestRepo: new FakeRequestRepo(),
    });
    await expect(
      useCase.execute({
        requestId: 'nonexistent',
        customerId: 'cust-001',
        documentType: DocumentType.AADHAAR,
        fileBytes: Buffer.from('x'),
        ...actorFields,
      }),
    ).rejects.toBeInstanceOf(VerificationRequestNotFoundError);
  });

  it('throws UploadDocumentCustomerNotFoundError for an unknown customer', async () => {
    const requestRepo = new FakeRequestRepo();
    requestRepo.seed(makeRequest());
    const useCase = makeUseCase({ customerRepo: new FakeCustomerRepo(), requestRepo });
    await expect(
      useCase.execute({
        requestId: 'req-001',
        customerId: 'nonexistent',
        documentType: DocumentType.AADHAAR,
        fileBytes: Buffer.from('x'),
        ...actorFields,
      }),
    ).rejects.toBeInstanceOf(UploadDocumentCustomerNotFoundError);
  });

  it('uploads the document and transitions to DOCUMENTS_RECEIVED without running the workflow when mandatory docs are still missing', async () => {
    const configProvider: WorkflowConfigProvider = {
      getConfig: () => ({
        ...makeConfigProvider().getConfig(KycTier.MINIMUM),
        requiredDocuments: [
          { documentType: DocumentType.AADHAAR, mandatory: true },
          { documentType: DocumentType.PAN, mandatory: true }, // second mandatory doc never uploaded in this test
        ],
      }),
    };
    const customerRepo = new FakeCustomerRepo();
    customerRepo.seed(makeCustomer());
    const requestRepo = new FakeRequestRepo();
    requestRepo.seed(makeRequest());
    const documentRepo = new InMemoryDocumentRepository();
    const storage = new DocumentStorageService(
      new EncryptionService(new InMemoryKms()),
      new InMemoryObjectStore(),
      documentRepo,
      new InMemoryAuditTrail(),
    );
    const useCase = new UploadKycDocumentUseCase(
      customerRepo,
      requestRepo,
      documentRepo,
      storage,
      new InMemoryAuditTrail(),
      new InMemoryNotification(),
      configProvider,
      makeVendorFactory(),
      new TimerService(new InMemoryTimerRepository()),
    );
    const result = await useCase.execute({
      requestId: 'req-001',
      customerId: 'cust-001',
      documentType: DocumentType.AADHAAR,
      fileBytes: Buffer.from('x'),
      ...actorFields,
    });
    expect(result.allRequiredDocumentsPresent).toBe(false);
    expect(result.requestStatus).toBe(VerificationStatus.DOCUMENTS_RECEIVED);
  });

  it('runs the full workflow and reaches VERIFIED when all mandatory documents are present and every vendor step succeeds', async () => {
    const customerRepo = new FakeCustomerRepo();
    customerRepo.seed(makeCustomer());
    const requestRepo = new FakeRequestRepo();
    requestRepo.seed(makeRequest());
    const useCase = makeUseCase({ customerRepo, requestRepo });
    const result = await useCase.execute({
      requestId: 'req-001',
      customerId: 'cust-001',
      documentType: DocumentType.AADHAAR,
      fileBytes: Buffer.from('x'),
      ...actorFields,
    });
    expect(result.allRequiredDocumentsPresent).toBe(true);
    expect(result.requestStatus).toBe(VerificationStatus.VERIFIED);
  });

  it('reaches REJECTED when a vendor step fails', async () => {
    const customerRepo = new FakeCustomerRepo();
    customerRepo.seed(makeCustomer());
    const requestRepo = new FakeRequestRepo();
    requestRepo.seed(makeRequest());
    const failingAml = {
      initiateVerification: jest
        .fn()
        .mockResolvedValue({ vendorReferenceId: 'ref-2', isAsync: false }),
      fetchResult: jest
        .fn()
        .mockResolvedValue({ vendorReferenceId: 'ref-2', success: false, normalisedData: {} }),
    };
    const useCase = makeUseCase({
      customerRepo,
      requestRepo,
      vendorFactory: makeVendorFactory({ aml: failingAml }),
    });
    const result = await useCase.execute({
      requestId: 'req-001',
      customerId: 'cust-001',
      documentType: DocumentType.AADHAAR,
      fileBytes: Buffer.from('x'),
      ...actorFields,
    });
    expect(result.requestStatus).toBe(VerificationStatus.REJECTED);
  });

  it('reaches VENDOR_CALLBACK_AWAITED and schedules a 72h timer when a step is async', async () => {
    const configProvider: WorkflowConfigProvider = {
      getConfig: () => ({
        ...makeConfigProvider().getConfig(KycTier.EDD),
        steps: [
          {
            stepName: 'video-kyc-session',
            vendorType: VendorType.VIDEO_KYC,
            order: 1,
            parallelGroup: null,
            guardExpression: null,
            timeoutSeconds: null,
            isAsync: true,
          },
        ],
      }),
    };
    const asyncVideoKyc = {
      initiateVerification: jest
        .fn()
        .mockResolvedValue({ vendorReferenceId: 'sess-1', isAsync: true }),
      fetchResult: jest.fn(),
    };
    const vendorFactory = {
      getAdapter: jest.fn().mockReturnValue(asyncVideoKyc),
    } as unknown as VendorAdapterFactory;

    const customerRepo = new FakeCustomerRepo();
    customerRepo.seed(makeCustomer());
    const requestRepo = new FakeRequestRepo();
    requestRepo.seed(makeRequest());
    const documentRepo = new InMemoryDocumentRepository();
    const storage = new DocumentStorageService(
      new EncryptionService(new InMemoryKms()),
      new InMemoryObjectStore(),
      documentRepo,
      new InMemoryAuditTrail(),
    );
    const timerRepo = new InMemoryTimerRepository();
    const useCase = new UploadKycDocumentUseCase(
      customerRepo,
      requestRepo,
      documentRepo,
      storage,
      new InMemoryAuditTrail(),
      new InMemoryNotification(),
      configProvider,
      vendorFactory,
      new TimerService(timerRepo),
    );
    const result = await useCase.execute({
      requestId: 'req-001',
      customerId: 'cust-001',
      documentType: DocumentType.AADHAAR,
      fileBytes: Buffer.from('x'),
      ...actorFields,
    });
    expect(result.requestStatus).toBe(VerificationStatus.VENDOR_CALLBACK_AWAITED);
    const timers = await timerRepo.findDue(new Date(Date.now() + 73 * 60 * 60 * 1000));
    expect(timers).toHaveLength(1);
  });

  it('persists the final status on both the VerificationRequest and the Customer', async () => {
    const customerRepo = new FakeCustomerRepo();
    customerRepo.seed(makeCustomer());
    const requestRepo = new FakeRequestRepo();
    requestRepo.seed(makeRequest());
    const useCase = makeUseCase({ customerRepo, requestRepo });
    await useCase.execute({
      requestId: 'req-001',
      customerId: 'cust-001',
      documentType: DocumentType.AADHAAR,
      fileBytes: Buffer.from('x'),
      ...actorFields,
    });
    const reloadedRequest = await requestRepo.findById('req-001');
    const reloadedCustomer = await customerRepo.findById('cust-001');
    expect(reloadedRequest!.status).toBe(VerificationStatus.VERIFIED);
    expect(reloadedCustomer!.kycStatus).toBe(VerificationStatus.VERIFIED);
  });
});
