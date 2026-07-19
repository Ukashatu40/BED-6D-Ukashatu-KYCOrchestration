// src/infrastructure/persistence/in-memory-document-repository.ts
import { Document } from '../../domain/entities/document.entity';
import { DocumentRepositoryPort } from '../../application/ports/document-repository.port';

/** Test/dev fake. Production adapter is Prisma-backed (built later this Day 4). */
export class InMemoryDocumentRepository implements DocumentRepositoryPort {
  private readonly documents = new Map<string, Document>();

  async save(document: Document): Promise<void> {
    this.documents.set(document.documentId, document);
  }

  async findById(documentId: string): Promise<Document | null> {
    return this.documents.get(documentId) ?? null;
  }
}
