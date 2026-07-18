// src/infrastructure/vendors/ckyc/ckyc.types.ts
import { DocumentType } from '../../../domain/value-objects/document-type.enum';

export interface CkycSearchResult {
  found: boolean;
  kin?: string; // 14-digit KYC Identification Number
  lastUpdatedAt?: string;
}

export interface CkycDocumentRecord {
  documentType: DocumentType;
  base64Content: string;
}

export interface CkycDownloadResult {
  kin: string;
  name: string;
  dateOfBirth: string;
  address: string;
  documents: CkycDocumentRecord[];
  lastUpdatedAt: string;
}

export interface CkycUploadRecord {
  customerId: string; // used only to correlate batch results back to our domain, never sent as-is to CERSAI
  name: string;
  dateOfBirth: string;
  address: string;
  panNumber: string;
  documents: CkycDocumentRecord[];
}

export interface CkycUploadResult {
  customerId: string;
  success: boolean;
  kin?: string;
  errorCode?: string;
}

export interface CkycBatchUploadResult {
  batchId: string;
  results: CkycUploadResult[];
}

export interface CkycVendorError {
  code: string; // e.g. 'record-not-found', 'certificate-expired'
  message: string;
}
