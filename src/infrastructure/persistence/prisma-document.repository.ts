// src/infrastructure/persistence/prisma-document.repository.ts
import { Document } from '../../domain/entities/document.entity';
import { DocumentType } from '../../domain/value-objects/document-type.enum';
import { DocumentRepositoryPort } from '../../application/ports/document-repository.port';
import { PrismaService } from './prisma.service';
import type { Document as PrismaDocumentRow } from '@prisma/client';

export class PrismaDocumentRepository implements DocumentRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async save(document: Document): Promise<void> {
    const props = document.toProps();
    await this.prisma.document.upsert({
      where: { documentId: props.documentId },
      create: {
        documentId: props.documentId,
        customerId: props.customerId,
        documentType: props.documentType as DocumentType,
        storagePath: props.storagePath,
        encryptionDekEncrypted: props.encryption.encryptionDekEncrypted,
        encryptionIv: props.encryption.encryptionIv,
        encryptionAuthTag: props.encryption.encryptionAuthTag,
        encryptionKekVersion: props.encryption.encryptionKekVersion,
        hashSha256: props.hashSha256,
        // Document.fileSizeBytes is a plain JS `number` on the domain
        // entity (Day 1) but the column is BIGINT/bigint in Prisma —
        // explicit BigInt() conversion here is the one place that seam is
        // reconciled, flagged back in the schema commit's notes.
        fileSizeBytes: BigInt(props.fileSizeBytes),
        mimeType: props.mimeType,
        uploadedBy: props.uploadedBy,
        expiresAt: props.expiresAt ?? null,
        isActive: props.isActive,
      },
      update: {
        isActive: props.isActive,
        expiresAt: props.expiresAt ?? null,
      },
    });
  }

  async findById(documentId: string): Promise<Document | null> {
    const row = await this.prisma.document.findUnique({ where: { documentId } });
    return row ? this.toDomain(row) : null;
  }

  private toDomain(row: PrismaDocumentRow): Document {
    return Document.reconstitute({
      documentId: row.documentId,
      customerId: row.customerId,
      documentType: row.documentType as unknown as DocumentType,
      storagePath: row.storagePath,
      encryption: {
        encryptionDekEncrypted: Buffer.from(row.encryptionDekEncrypted),
        encryptionIv: Buffer.from(row.encryptionIv),
        encryptionAuthTag: Buffer.from(row.encryptionAuthTag),
        encryptionKekVersion: row.encryptionKekVersion,
      },
      hashSha256: row.hashSha256,
      fileSizeBytes: Number(row.fileSizeBytes), // BigInt -> number: safe here since real documents are far below Number.MAX_SAFE_INTEGER bytes
      mimeType: row.mimeType,
      uploadedAt: row.uploadedAt,
      uploadedBy: row.uploadedBy,
      expiresAt: row.expiresAt,
      isActive: row.isActive,
    });
  }
}
