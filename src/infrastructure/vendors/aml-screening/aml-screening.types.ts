// src/infrastructure/vendors/aml-screening/aml-screening.types.ts
export type ScreeningType = 'SANCTIONS' | 'PEP' | 'ADVERSE_MEDIA' | 'COMBINED';

export interface AmlScreeningRequest {
  customerId: string;
  fullName: string;
  dateOfBirth: string;
  nationality?: string;
  screeningType: ScreeningType;
  fuzzyMatchThreshold: number; // 70-100 per spec
}

export interface AmlMatchDetail {
  matchedList: string;
  matchedName: string;
  matchConfidence: number; // 0-100
  matchedAttributes: Record<string, unknown>;
  riskScore: number; // 0-100
}

export interface AmlScreeningResponse {
  vendorScreeningId: string;
  matchCount: number;
  matches: AmlMatchDetail[];
  highestRiskScore: number;
  highestConfidence: number;
}

export interface AmlBatchScreeningRequest {
  entities: AmlScreeningRequest[];
}

export interface AmlBatchScreeningResponse {
  batchId: string;
  results: Array<{ customerId: string; response: AmlScreeningResponse }>;
}

export interface AmlMonitoringWebhookPayload {
  eventId: string;
  event: 'monitoring.new_match' | 'monitoring.list_updated';
  customerId: string;
  match?: AmlMatchDetail;
}
