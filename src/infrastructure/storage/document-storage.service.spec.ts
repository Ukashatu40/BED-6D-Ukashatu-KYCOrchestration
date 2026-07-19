// src/infrastructure/storage/document-storage.service.spec.ts
import {
  DocumentStorageService,
  DocumentAccessDeniedError,
  DocumentNotFoundError,
} from './document-storage.service';
import { EncryptionService } from '../encryption/encryption.service';
import { InMemoryKms } from '../encryption/in-memory-kms';
import { InMemoryObjectStore } from './in-memory-object-store';
import { InMemoryDocumentRepository } from '../persistence/in-memory-document-repository';
import { InMemoryAuditTrail } from '../audit/in-memory-audit-trail';
import { DocumentType } from '../../domain/value-objects/document-type.enum';
import { AuditActorType } from '../../domain/entities/audit-event.entity';
import { describe, expect, it, jest } from '@jest/globals';

function makeService() {
  const encryptionService = new EncryptionService(new InMemoryKms());
  const objectStore = new InMemoryObjectStore();
  const documentRepository = new InMemoryDocumentRepository();
  const auditTrail = new InMemoryAuditTrail();
  return {
    service: new DocumentStorageService(
      encryptionService,
      objectStore,
      documentRepository,
      auditTrail,
    ),
    objectStore,
    documentRepository,
    auditTrail,
  };
}

const actor = { actorType: AuditActorType.USER, actorId: 'user-001', correlationId: 'corr-001' };

describe('DocumentStorageService', () => {
  describe('uploadDocument', () => {
    it('stores the encrypted document and returns metadata (never plaintext) to the caller', async () => {
      const { service } = makeService();
      const plaintext = Buffer.from('Aadhaar scan bytes');
      const document = await service.uploadDocument(
        'cust-001',
        DocumentType.AADHAAR,
        plaintext,
        actor,
      );
      expect(document.documentId).toBeDefined();
      expect(document.toProps().fileSizeBytes).toBe(plaintext.length);
    });

    it('stores ciphertext (not plaintext) in the object store', async () => {
      const { service, objectStore } = makeService();
      const plaintext = Buffer.from('sensitive content');
      const document = await service.uploadDocument('cust-001', DocumentType.PAN, plaintext, actor);
      const stored = await objectStore.getObject(document.toProps().storagePath);
      expect(stored.equals(plaintext)).toBe(false);
    });

    it('computes the correct SHA-256 hash of the original plaintext', async () => {
      const { service } = makeService();
      const plaintext = Buffer.from('hash me');
      const document = await service.uploadDocument('cust-001', DocumentType.PAN, plaintext, actor);
      const expectedHash = require('crypto').createHash('sha256').update(plaintext).digest('hex');
      expect(document.toProps().hashSha256).toBe(expectedHash);
    });

    it('follows the storage path convention /{environment}/{customer_id}/{document_type}/{document_id}.enc', async () => {
      const { service } = makeService();
      const document = await service.uploadDocument(
        'cust-001',
        DocumentType.AADHAAR,
        Buffer.from('x'),
        actor,
      );
      const path = document.toProps().storagePath;
      expect(path).toMatch(new RegExp(`^/.+/cust-001/AADHAAR/${document.documentId}\\.enc$`));
    });

    it('audit-logs the upload with full actor identification', async () => {
      const { service, auditTrail } = makeService();
      await service.uploadDocument('cust-001', DocumentType.AADHAAR, Buffer.from('x'), actor);
      const events = auditTrail.getEventsForCustomer('cust-001');
      expect(events).toHaveLength(1);
      expect(events[0].toProps()).toMatchObject({
        eventType: 'DocumentUploaded',
        actorType: AuditActorType.USER,
        actorId: 'user-001',
        correlationId: 'corr-001',
      });
    });
  });

  describe('getDocument — decryption', () => {
    it('returns the exact original plaintext', async () => {
      const { service } = makeService();
      const plaintext = Buffer.from('round trip me');
      const document = await service.uploadDocument('cust-001', DocumentType.PAN, plaintext, actor);
      const retrieved = await service.getDocument(document.documentId, actor);
      expect(retrieved.equals(plaintext)).toBe(true);
    });

    it('audit-logs a DocumentDecrypted event distinct from DocumentUploaded', async () => {
      const { service, auditTrail } = makeService();
      const document = await service.uploadDocument(
        'cust-001',
        DocumentType.PAN,
        Buffer.from('x'),
        actor,
      );
      await service.getDocument(document.documentId, actor);
      const events = auditTrail.getEventsForCustomer('cust-001');
      expect(events.map((e) => e.toProps().eventType)).toEqual([
        'DocumentUploaded',
        'DocumentDecrypted',
      ]);
    });

    it('chains the decryption audit event to the upload event via previousEventHash', async () => {
      const { service, auditTrail } = makeService();
      const document = await service.uploadDocument(
        'cust-001',
        DocumentType.PAN,
        Buffer.from('x'),
        actor,
      );
      await service.getDocument(document.documentId, actor);
      const events = auditTrail.getEventsForCustomer('cust-001');
      expect(events[1].previousEventHash).toBe(events[0].eventHash);
    });

    it('throws DocumentNotFoundError for an unknown document ID', async () => {
      const { service } = makeService();
      await expect(service.getDocument('nonexistent', actor)).rejects.toBeInstanceOf(
        DocumentNotFoundError,
      );
    });

    it('throws DocumentAccessDeniedError for a deactivated document', async () => {
      const { service } = makeService();
      const document = await service.uploadDocument(
        'cust-001',
        DocumentType.PAN,
        Buffer.from('x'),
        actor,
      );
      await service.deactivateDocument(document.documentId, actor);
      await expect(service.getDocument(document.documentId, actor)).rejects.toBeInstanceOf(
        DocumentAccessDeniedError,
      );
    });
  });

  describe('getDocumentMetadata', () => {
    it('returns metadata without exposing plaintext or ciphertext', async () => {
      const { service } = makeService();
      const document = await service.uploadDocument(
        'cust-001',
        DocumentType.PAN,
        Buffer.from('secret'),
        actor,
      );
      const metadata = await service.getDocumentMetadata(document.documentId, actor);
      expect(metadata).not.toHaveProperty('ciphertext');
      expect(metadata).not.toHaveProperty('plaintext');
      expect(metadata.documentId).toBe(document.documentId);
    });

    it('audit-logs metadata views as a distinct event type from decryption', async () => {
      const { service, auditTrail } = makeService();
      const document = await service.uploadDocument(
        'cust-001',
        DocumentType.PAN,
        Buffer.from('x'),
        actor,
      );
      await service.getDocumentMetadata(document.documentId, actor);
      const events = auditTrail.getEventsForCustomer('cust-001');
      expect(events[1].toProps().eventType).toBe('DocumentMetadataViewed');
    });

    it('throws DocumentNotFoundError for an unknown document ID', async () => {
      const { service } = makeService();
      await expect(service.getDocumentMetadata('nonexistent', actor)).rejects.toBeInstanceOf(
        DocumentNotFoundError,
      );
    });

    it('is still accessible (metadata) even for a deactivated document, unlike getDocument', async () => {
      const { service } = makeService();
      const document = await service.uploadDocument(
        'cust-001',
        DocumentType.PAN,
        Buffer.from('x'),
        actor,
      );
      await service.deactivateDocument(document.documentId, actor);
      const metadata = await service.getDocumentMetadata(document.documentId, actor);
      expect(metadata.isActive).toBe(false);
    });
  });

  describe('deactivateDocument', () => {
    it('marks the document inactive', async () => {
      const { service, documentRepository } = makeService();
      const document = await service.uploadDocument(
        'cust-001',
        DocumentType.PAN,
        Buffer.from('x'),
        actor,
      );
      await service.deactivateDocument(document.documentId, actor);
      const reloaded = await documentRepository.findById(document.documentId);
      expect(reloaded?.isActive).toBe(false);
    });

    it('audit-logs the deactivation', async () => {
      const { service, auditTrail } = makeService();
      const document = await service.uploadDocument(
        'cust-001',
        DocumentType.PAN,
        Buffer.from('x'),
        actor,
      );
      await service.deactivateDocument(document.documentId, actor);
      const events = auditTrail.getEventsForCustomer('cust-001');
      expect(events.some((e) => e.toProps().eventType === 'DocumentDeactivated')).toBe(true);
    });

    it('throws DocumentNotFoundError for an unknown document ID', async () => {
      const { service } = makeService();
      await expect(service.deactivateDocument('nonexistent', actor)).rejects.toBeInstanceOf(
        DocumentNotFoundError,
      );
    });
  });

  describe('access control enforcement (unauthorised role scenario)', () => {
    it('every access is attributable to a specific actor regardless of actor type', async () => {
      const { service, auditTrail } = makeService();
      const vendorActor = {
        actorType: AuditActorType.VENDOR,
        actorId: 'ckyc-adapter',
        correlationId: 'corr-002',
      };
      const document = await service.uploadDocument(
        'cust-001',
        DocumentType.PAN,
        Buffer.from('x'),
        vendorActor,
      );
      const events = auditTrail.getEventsForCustomer('cust-001');
      expect(events[0].toProps().actorType).toBe(AuditActorType.VENDOR);
      expect(events[0].toProps().actorId).toBe('ckyc-adapter');
    });
  });
});
