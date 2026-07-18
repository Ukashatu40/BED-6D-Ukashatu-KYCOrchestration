// src/infrastructure/vendors/aml-screening/aml-screening-http-client.interface.ts
import {
  AmlBatchScreeningRequest,
  AmlBatchScreeningResponse,
  AmlScreeningRequest,
  AmlScreeningResponse,
} from './aml-screening.types';

export interface AmlScreeningHttpClient {
  screenRealTime(request: AmlScreeningRequest, signature: string): Promise<AmlScreeningResponse>;
  screenBatch(
    request: AmlBatchScreeningRequest,
    signature: string,
  ): Promise<AmlBatchScreeningResponse>;
  registerOngoingMonitoring(customerId: string): Promise<{ monitoringWebhookId: string }>;
}
