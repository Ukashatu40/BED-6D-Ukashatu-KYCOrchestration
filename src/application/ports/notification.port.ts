// src/application/ports/notification.port.ts
export interface NotificationParams {
  customerId: string;
  channel: 'EMAIL' | 'SMS' | 'IN_APP';
  templateId: string;
  data: Record<string, unknown>;
}

export interface NotificationPort {
  send(params: NotificationParams): Promise<void>;
}
