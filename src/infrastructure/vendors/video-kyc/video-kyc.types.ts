// src/infrastructure/vendors/video-kyc/video-kyc.types.ts
export type SigniVisionSessionEvent =
  'session.started' | 'session.completed' | 'session.failed' | 'session.expired';

export interface SigniVisionSessionCreateParams {
  customerId: string;
  livenessThreshold: number; // 0.0–1.0, spec recommends 0.85
  faceMatchThreshold: number; // percentage
  sessionTimeoutSeconds: number;
}

export interface SigniVisionSessionCreateResult {
  sessionId: string;
  sessionUrl: string;
}

export interface SigniVisionWebhookPayload {
  eventId: string;
  event: SigniVisionSessionEvent;
  sessionId: string;
  livenessScore?: number; // present on session.completed
  faceMatchConfidence?: number; // present on session.completed, 0-100
  recordingUrl?: string;
  errorCode?: string; // present on session.failed
}
