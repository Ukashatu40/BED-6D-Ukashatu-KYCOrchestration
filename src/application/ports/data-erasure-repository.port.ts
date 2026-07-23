// src/application/ports/data-erasure-repository.port.ts
import { LegalHold } from '../../domain/data-erasure/legal-hold-evaluator';
import { DataCategory } from '../../domain/data-erasure/data-category';

export type ErasureStatus =
  'RECEIVED' | 'EVALUATING' | 'PARTIALLY_EXECUTED' | 'SCHEDULED' | 'COMPLETED' | 'REJECTED';

export interface DataErasureRequestRecord {
  requestId: string;
  customerId: string;
  requestorId: string;
  requestDate: Date;
  status: ErasureStatus;
  legalHolds: LegalHold[];
  eligibleDataCategories: DataCategory[];
  anonymisedDataCategories: DataCategory[] | null;
  scheduledCompletionDate: Date | null;
  responseSentAt: Date | null;
  completedAt: Date | null;
}

export interface DataErasureRepositoryPort {
  save(record: DataErasureRequestRecord): Promise<void>;
  findById(requestId: string): Promise<DataErasureRequestRecord | null>;
}
