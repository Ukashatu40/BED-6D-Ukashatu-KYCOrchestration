// src/application/ports/webhook-deduplication.port.ts
/**
 * Tracks processed webhook event IDs to guarantee idempotent handling of
 * at-least-once delivery. Real implementation is Redis-backed (Day 3+) with
 * a 72-hour TTL per spec; this port lets adapters be unit-tested against an
 * in-memory fake today.
 */
export interface WebhookDeduplicationPort {
  hasBeenProcessed(eventId: string): Promise<boolean>;
  markProcessed(eventId: string, ttlSeconds: number): Promise<void>;
}
