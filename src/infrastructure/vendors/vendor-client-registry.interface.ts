// src/infrastructure/vendors/vendor-client-registry.interface.ts
import { DigilockerHttpClient } from './digilocker/digilocker-http-client.interface';
import { CkycSoapClient } from './ckyc/ckyc-soap-client.interface';
import { VideoKycHttpClient } from './video-kyc/video-kyc-http-client.interface';
import { AmlScreeningHttpClient } from './aml-screening/aml-screening-http-client.interface';

/**
 * Bag of concrete transport clients the factory wires into adapters. One
 * implementation for production (real HTTP/SOAP clients hitting vendor
 * sandboxes), one for tests (mocks). Neither the factory nor any adapter
 * cares which — that's the entire point of ADR-001.
 */
export interface VendorClientRegistry {
  digilocker: DigilockerHttpClient;
  ckyc: CkycSoapClient;
  videoKyc: VideoKycHttpClient;
  amlScreening: AmlScreeningHttpClient;
}
