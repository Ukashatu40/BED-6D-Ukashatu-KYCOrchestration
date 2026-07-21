// src/application/use-cases/get-kyc-status.use-case.ts
import { VerificationRequestRepositoryPort } from '../ports/verification-request-repository.port';

export class KycStatusNotFoundError extends Error {
  constructor(requestId: string) {
    super(`No verification request found with ID ${requestId}`);
    this.name = 'KycStatusNotFoundError';
  }
}

export class GetKycStatusUseCase {
  constructor(private readonly requestRepository: VerificationRequestRepositoryPort) {}

  async execute(requestId: string) {
    const request = await this.requestRepository.findById(requestId);
    if (!request) throw new KycStatusNotFoundError(requestId);
    const props = request.toProps();
    return {
      requestId: props.requestId,
      customerId: props.customerId,
      tier: props.tier,
      status: props.status,
      currentStep: props.currentStep,
      createdAt: props.createdAt,
      completedAt: props.completedAt,
      expiresAt: props.expiresAt,
    };
  }
}
