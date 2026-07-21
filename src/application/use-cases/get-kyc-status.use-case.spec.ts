// src/application/use-cases/get-kyc-status.use-case.spec.ts
import { GetKycStatusUseCase, KycStatusNotFoundError } from './get-kyc-status.use-case';
import { VerificationRequestRepositoryPort } from '../ports/verification-request-repository.port';
import { VerificationRequest } from '../../domain/entities/verification-request.entity';
import { KycTier } from '../../domain/value-objects/kyc-tier.enum';
import { VerificationStatus } from '../../domain/value-objects/verification-status.enum';
import { expect, describe, it } from '@jest/globals';

class FakeRepo implements VerificationRequestRepositoryPort {
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

describe('GetKycStatusUseCase', () => {
  it('returns status details for an existing request', async () => {
    const repo = new FakeRepo();
    repo.seed(
      VerificationRequest.reconstitute({
        requestId: 'req-001',
        customerId: 'cust-001',
        tier: KycTier.MINIMUM,
        workflowConfigVersion: '1.0.0',
        currentStep: 'aadhaar-fetch',
        status: VerificationStatus.VERIFICATION_IN_PROGRESS,
        initiatedBy: 'system',
        createdAt: new Date(),
        completedAt: null,
        expiresAt: new Date(Date.now() + 60000),
        retryOf: null,
      }),
    );
    const result = await new GetKycStatusUseCase(repo).execute('req-001');
    expect(result.status).toBe(VerificationStatus.VERIFICATION_IN_PROGRESS);
  });

  it('throws KycStatusNotFoundError for an unknown requestId', async () => {
    const repo = new FakeRepo();
    await expect(new GetKycStatusUseCase(repo).execute('nonexistent')).rejects.toBeInstanceOf(
      KycStatusNotFoundError,
    );
  });
});
