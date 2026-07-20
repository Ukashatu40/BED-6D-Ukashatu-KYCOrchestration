// src/application/ports/verification-request-repository.port.ts
import { VerificationRequest } from '../../domain/entities/verification-request.entity';

export interface VerificationRequestRepositoryPort {
  save(request: VerificationRequest): Promise<void>;
  findById(requestId: string): Promise<VerificationRequest | null>;
  findLatestForCustomer(customerId: string): Promise<VerificationRequest | null>;
  findExpiring(before: Date): Promise<VerificationRequest[]>;
}
