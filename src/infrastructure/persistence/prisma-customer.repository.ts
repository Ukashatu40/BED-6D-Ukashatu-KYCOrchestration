// src/infrastructure/persistence/prisma-customer.repository.ts
import { Customer, RiskFactorBreakdown } from '../../domain/entities/customer.entity';
import { KycTier } from '../../domain/value-objects/kyc-tier.enum';
import { VerificationStatus } from '../../domain/value-objects/verification-status.enum';
import { RiskScore } from '../../domain/value-objects/risk-score.vo';
import { CustomerRepositoryPort } from '../../application/ports/customer-repository.port';
import { PrismaService } from './prisma.service';
import type { Customer as PrismaCustomerRow } from '@prisma/client';

/**
 * Prisma-backed CustomerRepositoryPort. The only place in the codebase
 * that maps between the Prisma row shape (snake_case columns, Prisma enum
 * strings) and the domain Customer entity (Day 1) — no other layer should
 * ever import @prisma/client types directly, per ADR-001's hexagonal
 * boundary.
 */
export class PrismaCustomerRepository implements CustomerRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async save(customer: Customer): Promise<void> {
    const props = customer.toProps();
    await this.prisma.customer.upsert({
      where: { customerId: props.customerId },
      create: {
        customerId: props.customerId,
        externalId: props.externalId,
        fullNameEncrypted: props.fullNameEncrypted,
        dateOfBirthEncrypted: props.dateOfBirthEncrypted,
        kycTier: props.kycTier as KycTier,
        kycStatus: props.kycStatus as VerificationStatus,
        riskScore: props.riskScore.getValue(),
        riskFactors: props.riskFactors as unknown as object,
        ckycKin: props.ckycKin ?? null,
        lastVerifiedAt: props.lastVerifiedAt ?? null,
        nextVerificationDue: props.nextVerificationDue ?? null,
      },
      update: {
        kycTier: props.kycTier as KycTier,
        kycStatus: props.kycStatus as VerificationStatus,
        riskScore: props.riskScore.getValue(),
        riskFactors: props.riskFactors as unknown as object,
        ckycKin: props.ckycKin ?? null,
        lastVerifiedAt: props.lastVerifiedAt ?? null,
        nextVerificationDue: props.nextVerificationDue ?? null,
        updatedAt: new Date(),
      },
    });
  }

  async findById(customerId: string): Promise<Customer | null> {
    const row = await this.prisma.customer.findUnique({ where: { customerId } });
    return row ? this.toDomain(row) : null;
  }

  async findByExternalId(externalId: string): Promise<Customer | null> {
    const row = await this.prisma.customer.findUnique({ where: { externalId } });
    return row ? this.toDomain(row) : null;
  }

  async findByCkycKin(kin: string): Promise<Customer | null> {
    const row = await this.prisma.customer.findFirst({ where: { ckycKin: kin } });
    return row ? this.toDomain(row) : null;
  }

  async findDueForReVerification(asOf: Date): Promise<Customer[]> {
    const rows = await this.prisma.customer.findMany({
      where: { nextVerificationDue: { lte: asOf } },
    });
    return rows.map((row) => this.toDomain(row));
  }

  private toDomain(row: PrismaCustomerRow): Customer {
    return Customer.reconstitute({
      customerId: row.customerId,
      externalId: row.externalId,
      fullNameEncrypted: Buffer.from(row.fullNameEncrypted),
      dateOfBirthEncrypted: Buffer.from(row.dateOfBirthEncrypted),
      kycTier: row.kycTier as unknown as KycTier,
      kycStatus: row.kycStatus as unknown as VerificationStatus,
      riskScore: RiskScore.create(row.riskScore),
      riskFactors: row.riskFactors as unknown as RiskFactorBreakdown,
      ckycKin: row.ckycKin,
      lastVerifiedAt: row.lastVerifiedAt,
      nextVerificationDue: row.nextVerificationDue,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    });
  }
}
