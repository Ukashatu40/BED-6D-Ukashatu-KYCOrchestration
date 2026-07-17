// src/domain/entities/customer.entity.spec.ts
import { Customer } from './customer.entity';
import { KycTier } from '../value-objects/kyc-tier.enum';
import { VerificationStatus } from '../value-objects/verification-status.enum';
import { RiskScore } from '../value-objects/risk-score.vo';
import { describe, it, expect } from '@jest/globals';

const baseProps = () => ({
  customerId: 'cust-001',
  externalId: 'ext-001',
  fullNameEncrypted: Buffer.from('encrypted-name'),
  dateOfBirthEncrypted: Buffer.from('encrypted-dob'),
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

describe('Customer entity', () => {
  it('creates a valid customer', () => {
    const customer = Customer.create(baseProps());
    expect(customer.customerId).toBe('cust-001');
    expect(customer.kycStatus).toBe(VerificationStatus.NOT_STARTED);
  });

  it('rejects an empty externalId', () => {
    expect(() => Customer.create({ ...baseProps(), externalId: '' })).toThrow();
  });

  it('rejects a malformed CKYC KIN', () => {
    expect(() => Customer.create({ ...baseProps(), ckycKin: '12345' })).toThrow(
      'CKYC KIN must be exactly 14 digits',
    );
  });

  it('assigns a valid 14-digit CKYC KIN', () => {
    const customer = Customer.create(baseProps());
    customer.assignCkycKin('12345678901234');
    expect(customer.ckycKin).toBe('12345678901234');
  });

  it('throws when assigning a conflicting CKYC KIN', () => {
    const customer = Customer.create(baseProps());
    customer.assignCkycKin('12345678901234');
    expect(() => customer.assignCkycKin('99999999999999')).toThrow();
  });

  it('is idempotent when re-assigning the same CKYC KIN', () => {
    const customer = Customer.create(baseProps());
    customer.assignCkycKin('12345678901234');
    expect(() => customer.assignCkycKin('12345678901234')).not.toThrow();
  });

  it('allows a forward tier upgrade', () => {
    const customer = Customer.create(baseProps());
    customer.upgradeTier(KycTier.FULL);
    expect(customer.kycTier).toBe(KycTier.FULL);
  });

  it('rejects a non-forward tier change', () => {
    const customer = Customer.create({ ...baseProps(), kycTier: KycTier.FULL });
    expect(() => customer.upgradeTier(KycTier.MINIMUM)).toThrow();
  });

  it('updates risk score and factor breakdown together', () => {
    const customer = Customer.create(baseProps());
    const newScore = RiskScore.create(69);
    customer.updateRiskScore(newScore, {
      productType: 0.2,
      transactionAnomaly: 0.25,
      jurisdictionalRisk: 0.15,
      pepStatus: 0,
      amlResults: 0.2,
    });
    expect(customer.riskScore.getValue()).toBe(69);
    expect(customer.riskScore.exceedsEddThreshold()).toBe(true);
  });

  it('transitions status via the designated entry point', () => {
    const customer = Customer.create(baseProps());
    customer.transitionStatus(VerificationStatus.INITIATED);
    expect(customer.kycStatus).toBe(VerificationStatus.INITIATED);
  });

  it('correctly reports re-verification due date', () => {
    const past = new Date(Date.now() - 1000);
    const customer = Customer.create({
      ...baseProps(),
      nextVerificationDue: past,
    });
    expect(customer.isDueForReVerification()).toBe(true);
  });
});
