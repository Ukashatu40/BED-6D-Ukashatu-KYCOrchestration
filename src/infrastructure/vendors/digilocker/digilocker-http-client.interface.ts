// src/infrastructure/vendors/digilocker/digilocker-http-client.interface.ts
import { DocumentType } from '../../../domain/value-objects/document-type.enum';
import { DigilockerDocumentResponse, DigilockerOAuthToken } from './digilocker.types';

/**
 * Thin port over the actual Digilocker HTTP surface. Isolated behind an
 * interface so DigilockerAdapter is unit-testable without a live sandbox —
 * the real implementation (DigilockerHttpClientImpl) is wired in
 * infrastructure/vendors/digilocker/digilocker-http-client.impl.ts against
 * the sandbox in Day 2 integration testing, not covered here.
 */
export interface DigilockerHttpClient {
  exchangeAuthCode(authCode: string, pkceVerifier: string): Promise<DigilockerOAuthToken>;
  refreshAccessToken(refreshToken: string): Promise<DigilockerOAuthToken>;
  revokeToken(token: string): Promise<void>;
  fetchDocument(
    accessToken: string,
    documentType: DocumentType,
  ): Promise<DigilockerDocumentResponse>;
  getConsentStatus(consentId: string): Promise<'PENDING' | 'GRANTED' | 'DENIED' | 'EXPIRED'>;
}
