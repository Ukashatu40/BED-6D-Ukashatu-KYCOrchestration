// src/infrastructure/persistence/prisma-verification-request.repository.ts
import { VerificationRequest } from '../../domain/entities/verification-request.entity';
import { KycTier } from '../../domain/value-objects/kyc-tier.enum';
import { VerificationStatus } from '../../domain/value-objects/verification-status.enum';
import { VerificationRequestRepositoryPort } from '../../application/ports/verification-request-repository.port';
import { PrismaService } from './prisma.service';
import type { VerificationRequest as PrismaRequestRow } from '@prisma/client';

export class PrismaVerificationRequestRepository implements VerificationRequestRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async save(request: VerificationRequest): Promise<void> {
    const props = request.toProps();
    await this.prisma.verificationRequest.upsert({
      where: { requestId: props.requestId },
      create: {
        requestId: props.requestId,
        customerId: props.customerId,
        tier: props.tier as KycTier,
        workflowConfigVersion: props.workflowConfigVersion,
        currentStep: props.currentStep,
        status: props.status as VerificationStatus,
        initiatedBy: props.initiatedBy,
        expiresAt: props.expiresAt,
        completedAt: props.completedAt ?? null,
        retryOf: props.retryOf ?? null,
      },
      update: {
        currentStep: props.currentStep,
        status: props.status as VerificationStatus,
        completedAt: props.completedAt ?? null,
      },
    });
  }

  async findById(requestId: string): Promise<VerificationRequest | null> {
    const row = await this.prisma.verificationRequest.findUnique({ where: { requestId } });
    return row ? this.toDomain(row) : null;
  }

  async findLatestForCustomer(customerId: string): Promise<VerificationRequest | null> {
    const row = await this.prisma.verificationRequest.findFirst({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
    });
    return row ? this.toDomain(row) : null;
  }

  async findExpiring(before: Date): Promise<VerificationRequest[]> {
    const rows = await this.prisma.verificationRequest.findMany({
      where: { expiresAt: { lte: before }, completedAt: null },
    });
    return rows.map((row) => this.toDomain(row));
  }

  private toDomain(row: PrismaRequestRow): VerificationRequest {
    return VerificationRequest.reconstitute({
      requestId: row.requestId,
      customerId: row.customerId,
      tier: row.tier as unknown as KycTier,
      workflowConfigVersion: row.workflowConfigVersion,
      currentStep: row.currentStep,
      status: row.status as unknown as VerificationStatus,
      initiatedBy: row.initiatedBy,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
      expiresAt: row.expiresAt,
      retryOf: row.retryOf,
    });
  }
}
