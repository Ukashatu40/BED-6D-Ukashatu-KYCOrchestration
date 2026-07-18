// src/infrastructure/vendors/in-memory-webhook-deduplication.ts
import { WebhookDeduplicationPort } from '../../application/ports/webhook-deduplication.port';

/** Test/dev fake. Production adapter is Redis-backed (Day 3). */
export class InMemoryWebhookDeduplication implements WebhookDeduplicationPort {
  private readonly seen = new Map<string, number>(); // eventId -> expiryTimestampMs

  async hasBeenProcessed(eventId: string): Promise<boolean> {
    const expiry = this.seen.get(eventId);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) {
      this.seen.delete(eventId);
      return false;
    }
    return true;
  }

  async markProcessed(eventId: string, ttlSeconds: number): Promise<void> {
    this.seen.set(eventId, Date.now() + ttlSeconds * 1000);
  }
}
