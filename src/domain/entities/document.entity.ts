// src/domain/entities/document.entity.ts
import { DocumentType } from '../value-objects/document-type.enum';

export interface DocumentEncryptionMetadata {
  encryptionDekEncrypted: Buffer;
  encryptionIv: Buffer;
  encryptionAuthTag: Buffer;
  encryptionKekVersion: string;
}

export interface DocumentProps {
  documentId: string;
  customerId: string;
  documentType: DocumentType;
  storagePath: string;
  encryption: DocumentEncryptionMetadata;
  hashSha256: string;
  fileSizeBytes: number;
  mimeType: string;
  uploadedAt: Date;
  uploadedBy: string;
  expiresAt?: Date | null;
  isActive: boolean;
}

/**
 * Represents document *metadata* only. The entity never holds plaintext
 * bytes — those flow through EncryptionService/DocumentStorageService and
 * are never assigned to a domain object.
 */
export class Document {
  private props: DocumentProps;

  private constructor(props: DocumentProps) {
    this.props = props;
  }

  static create(props: Omit<DocumentProps, 'uploadedAt' | 'isActive'>): Document {
    if (props.fileSizeBytes <= 0) {
      throw new Error('Document.fileSizeBytes must be positive');
    }
    if (!/^[a-f0-9]{64}$/i.test(props.hashSha256)) {
      throw new Error('Document.hashSha256 must be a valid 64-character hex SHA-256 digest');
    }
    return new Document({ ...props, uploadedAt: new Date(), isActive: true });
  }

  static reconstitute(props: DocumentProps): Document {
    return new Document(props);
  }

  get documentId(): string {
    return this.props.documentId;
  }

  get documentType(): DocumentType {
    return this.props.documentType;
  }

  get isActive(): boolean {
    return this.props.isActive;
  }

  deactivate(): void {
    this.props.isActive = false;
  }

  toProps(): Readonly<DocumentProps> {
    return { ...this.props };
  }
}
