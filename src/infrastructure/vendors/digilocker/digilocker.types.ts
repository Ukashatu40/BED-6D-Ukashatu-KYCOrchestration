// src/infrastructure/vendors/digilocker/digilocker.types.ts
import { DocumentType } from '../../../domain/value-objects/document-type.enum';

export interface DigilockerOAuthToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface DigilockerDocumentResponse {
  documentType: DocumentType;
  base64Content: string;
  pkcs7Signature: string;
  extractedFields: {
    name: string;
    dateOfBirth: string;
    address?: string;
    documentNumber: string;
    issueDate?: string;
    expiryDate?: string;
  };
}

export interface DigilockerVendorError {
  code: string; // e.g. 'consent-expired', 'rate-limited'
  message: string;
}
