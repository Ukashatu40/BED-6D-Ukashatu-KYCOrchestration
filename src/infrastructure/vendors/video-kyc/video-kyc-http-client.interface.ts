// src/infrastructure/vendors/video-kyc/video-kyc-http-client.interface.ts
import { SigniVisionSessionCreateParams, SigniVisionSessionCreateResult } from './video-kyc.types';

export interface VideoKycHttpClient {
  createSession(params: SigniVisionSessionCreateParams): Promise<SigniVisionSessionCreateResult>;
  fetchRecordingUrl(sessionId: string): Promise<string>;
}
