// src/application/use-cases/get-risk-score.use-case.spec.ts
import { GetRiskScoreUseCase } from './get-risk-score.use-case';
import { CustomerNotFoundError } from './recalculate-risk-score.use-case';
import { CustomerRepositoryPort } from '../ports/customer-repository.port';
import { Customer } from '../../domain/entities/customer.entity';
import { KycTier } from '../../domain/value-objects/kyc-tier.enum';
import { VerificationStatus } from '../../domain/value-objects/verification-status.enum';
import { RiskScore } from '../../domain/value-objects/risk-score.vo';
import { expect, describe, it } from '@jest/globals';

class FakeRepo implements CustomerRepositoryPort {
  private customers = new Map<string, Customer>();
  seed(c: Customer) {
    this.customers.set(c.customerId, c);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async save(c: Customer) {
    this.customers.set(c.customerId, c);
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async findById(id: string) {
    return this.customers.get(id) ?? null;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async findByExternalId() {
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async findByCkycKin() {
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async findDueForReVerification() {
    return [];
  }
}

describe('GetRiskScoreUseCase', () => {
  it('returns score, breakdown, and threshold flag for an existing customer', async () => {
    const repo = new FakeRepo();
    repo.seed(
      Customer.create({
        customerId: 'cust-001',
        externalId: 'ext-001',
        fullNameEncrypted: Buffer.from('x'),
        dateOfBirthEncrypted: Buffer.from('x'),
        kycTier: KycTier.FULL,
        kycStatus: VerificationStatus.VERIFIED,
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
      }),
    );
    const result = await new GetRiskScoreUseCase(repo).execute('cust-001');
    expect(result.riskScore).toBe(65);
    expect(result.exceedsEddThreshold).toBe(true);
  });

  it('throws CustomerNotFoundError for an unknown customer', async () => {
    const repo = new FakeRepo();
    await expect(new GetRiskScoreUseCase(repo).execute('nonexistent')).rejects.toBeInstanceOf(
      CustomerNotFoundError,
    );
  });
});
