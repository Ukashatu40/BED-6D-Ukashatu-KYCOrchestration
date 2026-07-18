// src/infrastructure/vendors/ckyc/ckyc-soap-client.interface.ts
import {
  CkycBatchUploadResult,
  CkycDownloadResult,
  CkycSearchResult,
  CkycUploadRecord,
} from './ckyc.types';

/**
 * Port over the CKYC SOAP/XML surface. The real implementation
 * (ckyc-soap-client.impl.ts, built against the `soap` package with mutual
 * TLS) is wired in Day 4+ once certificate provisioning is sorted — kept
 * separate from CkycAdapter so the adapter's orchestration logic (retries,
 * error mapping, circuit breaking, KIN assignment) is fully unit-testable
 * against a mock today.
 */
export interface CkycSoapClient {
  search(panOrKin: string): Promise<CkycSearchResult>;
  download(kin: string): Promise<CkycDownloadResult>;
  upload(record: CkycUploadRecord): Promise<{ success: boolean; kin?: string; errorCode?: string }>;
  uploadBatch(records: CkycUploadRecord[]): Promise<CkycBatchUploadResult>;
}
