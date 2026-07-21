// src/application/ports/document-repository.port.ts
import { Document } from '../../domain/entities/document.entity';

export interface DocumentRepositoryPort {
  save(document: Document): Promise<void>;
  findById(documentId: string): Promise<Document | null>;
  /** NEW — needed to check "are all mandatory documents for this tier present" without the caller tracking uploads itself. */
  findActiveByCustomer(customerId: string): Promise<Document[]>;
}
