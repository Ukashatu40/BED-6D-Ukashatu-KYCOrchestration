// src/infrastructure/notification/in-memory-notification.ts
import { NotificationParams, NotificationPort } from '../../application/ports/notification.port';

/** Test/dev fake — logs to memory instead of dispatching real email/SMS. Production adapter (Day 6+ hardening) wires an actual provider. */
export class InMemoryNotification implements NotificationPort {
  public readonly sent: NotificationParams[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async send(params: NotificationParams): Promise<void> {
    this.sent.push(params);
  }
}
