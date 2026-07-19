// src/infrastructure/storage/document-storage.service.ts
import { randomUUID, createHash } from 'crypto';
import { Document } from '../../domain/entities/document.entity';
import { DocumentType } from '../../domain/value-objects/document-type.enum';
import { AuditActorType } from '../../domain/entities/audit-event.entity';
import { EncryptionService } from '../encryption/encryption.service';
import { ObjectStorePort } from '../../application/ports/object-store.port';
import { DocumentRepositoryPort } from '../../application/ports/document-repository.port';
import { AuditTrailPort } from '../../application/ports/audit-trail.port';

export interface ActorContext {
  actorType: AuditActorType;
  actorId: string;
  correlationId: string;
}

export class DocumentAccessDeniedError extends Error {
  constructor(documentId: string) {
    super(`Document ${documentId} is not active — access denied`);
    this.name = 'DocumentAccessDeniedError';
  }
}

export class DocumentNotFoundError extends Error {
  constructor(documentId: string) {
    super(`No document found with ID ${documentId}`);
    this.name = 'DocumentNotFoundError';
  }
}

const ENVIRONMENT = process.env.NODE_ENV ?? 'development';

/**
 * Orchestrates document upload/retrieval/deactivation across
 * EncryptionService (envelope encryption), ObjectStorePort (blob storage),
 * DocumentRepositoryPort (metadata persistence), and AuditTrailPort (access
 * logging). Per Section A3.6 and the security checklist: every operation
 * that touches a document — including metadata-only reads — is audit
 * logged with full actor identification. Plaintext bytes exist only as
 * local variables inside this class's own method bodies; they are never
 * assigned to Document (metadata-only) or logged.
 */
export class DocumentStorageService {
  constructor(
    private readonly encryptionService: EncryptionService,
    private readonly objectStore: ObjectStorePort,
    private readonly documentRepository: DocumentRepositoryPort,
    private readonly auditTrail: AuditTrailPort,
  ) {}

  async uploadDocument(
    customerId: string,
    documentType: DocumentType,
    fileBytes: Buffer,
    actor: ActorContext,
  ): Promise<Document> {
    const documentId = randomUUID();
    const storagePath = this.buildStoragePath(customerId, documentType, documentId);
    const hashSha256 = createHash('sha256').update(fileBytes).digest('hex');

    const envelope = await this.encryptionService.encryptDocument(fileBytes);
    // Storage happens BEFORE metadata persistence — if the object store
    // write fails, no orphaned Document row is left referencing a
    // nonexistent blob. Reverse ordering would risk exactly that.
    await this.objectStore.putObject(storagePath, envelope.ciphertext);

    const document = Document.create({
      documentId,
      customerId,
      documentType,
      storagePath,
      encryption: {
        encryptionDekEncrypted: envelope.encryptedDek,
        encryptionIv: envelope.iv,
        encryptionAuthTag: envelope.authTag,
        encryptionKekVersion: envelope.kekVersion,
      },
      hashSha256,
      fileSizeBytes: fileBytes.length,
      mimeType: this.inferMimeType(documentType),
      uploadedBy: actor.actorId,
      expiresAt: null,
    });

    await this.documentRepository.save(document);

    await this.auditTrail.recordEvent({
      customerId,
      eventType: 'DocumentUploaded',
      actorType: actor.actorType,
      actorId: actor.actorId,
      correlationId: actor.correlationId,
      eventPayload: {
        documentId,
        documentType,
        fileSizeBytes: fileBytes.length,
        hashSha256,
      },
    });

    return document;
  }

  /**
   * Retrieves and decrypts a document's plaintext bytes. Every call is
   * audit-logged regardless of outcome context (this is a read of PII —
   * the spec's Access Control Matrix treats "Decrypt" as a distinctly
   * loggable action from "View Meta").
   */
  async getDocument(documentId: string, actor: ActorContext): Promise<Buffer> {
    const document = await this.requireActiveDocument(documentId);
    const props = document.toProps();

    const ciphertext = await this.objectStore.getObject(props.storagePath);
    const plaintext = await this.encryptionService.decryptDocument({
      ciphertext,
      iv: props.encryption.encryptionIv,
      authTag: props.encryption.encryptionAuthTag,
      encryptedDek: props.encryption.encryptionDekEncrypted,
      kekVersion: props.encryption.encryptionKekVersion,
    });

    await this.auditTrail.recordEvent({
      customerId: props.customerId,
      eventType: 'DocumentDecrypted',
      actorType: actor.actorType,
      actorId: actor.actorId,
      correlationId: actor.correlationId,
      eventPayload: { documentId, documentType: props.documentType },
    });

    return plaintext;
  }

  /**
   * Metadata-only read — no decryption, no plaintext ever touched. Still
   * audit-logged per the spec's blanket "every operation must audit-log
   * the access" requirement, but as a distinct, lower-sensitivity event
   * type than DocumentDecrypted.
   */
  async getDocumentMetadata(documentId: string, actor: ActorContext) {
    const document = await this.requireActiveDocument(documentId);
    const props = document.toProps();

    await this.auditTrail.recordEvent({
      customerId: props.customerId,
      eventType: 'DocumentMetadataViewed',
      actorType: actor.actorType,
      actorId: actor.actorId,
      correlationId: actor.correlationId,
      eventPayload: { documentId, documentType: props.documentType },
    });

    return {
      documentId: props.documentId,
      customerId: props.customerId,
      documentType: props.documentType,
      fileSizeBytes: props.fileSizeBytes,
      mimeType: props.mimeType,
      uploadedAt: props.uploadedAt,
      uploadedBy: props.uploadedBy,
      isActive: props.isActive,
    };
  }

  async deactivateDocument(documentId: string, actor: ActorContext): Promise<void> {
    const document = await this.documentRepository.findById(documentId);
    if (!document) {
      throw new DocumentNotFoundError(documentId);
    }

    document.deactivate();
    await this.documentRepository.save(document);

    await this.auditTrail.recordEvent({
      customerId: document.toProps().customerId,
      eventType: 'DocumentDeactivated',
      actorType: actor.actorType,
      actorId: actor.actorId,
      correlationId: actor.correlationId,
      eventPayload: { documentId },
    });
  }

  private async requireActiveDocument(documentId: string): Promise<Document> {
    const document = await this.documentRepository.findById(documentId);
    if (!document) {
      throw new DocumentNotFoundError(documentId);
    }
    if (!document.isActive) {
      throw new DocumentAccessDeniedError(documentId);
    }
    return document;
  }

  private buildStoragePath(
    customerId: string,
    documentType: DocumentType,
    documentId: string,
  ): string {
    return `/${ENVIRONMENT}/${customerId}/${documentType}/${documentId}.enc`;
  }

  private inferMimeType(documentType: DocumentType): string {
    return documentType === DocumentType.VIDEO_RECORDING ? 'video/mp4' : 'application/octet-stream';
  }
}
