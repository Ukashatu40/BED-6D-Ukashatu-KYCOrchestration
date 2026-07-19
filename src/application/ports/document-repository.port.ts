// src/application/ports/document-repository.port.ts
import { Document } from '../../domain/entities/document.entity';

export interface DocumentRepositoryPort {
  save(document: Document): Promise<void>;
  findById(documentId: string): Promise<Document | null>;
}
