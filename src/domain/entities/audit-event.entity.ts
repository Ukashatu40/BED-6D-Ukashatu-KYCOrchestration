// src/domain/entities/audit-event.entity.ts
import { createHash } from 'crypto';

export enum AuditActorType {
  SYSTEM = 'SYSTEM',
  USER = 'USER',
  VENDOR = 'VENDOR',
  SCHEDULER = 'SCHEDULER',
}

export interface AuditEventProps {
  eventId: string;
  customerId: string | null;
  eventType: string;
  eventVersion: number;
  actorType: AuditActorType;
  actorId: string;
  correlationId: string;
  eventPayload: Record<string, unknown>;
  previousEventHash: string | null;
  eventHash: string;
  createdAt: Date;
}

/**
 * Immutable audit event with tamper-evident hash chaining.
 * hash = SHA-256(event_id + event_type + JSON(payload) + previous_event_hash + created_at)
 * per spec Section A3.5. Once constructed, an AuditEvent can never be mutated —
 * there is deliberately no setter on any field.
 */
export class AuditEvent {
  private readonly props: AuditEventProps;

  private constructor(props: AuditEventProps) {
    this.props = props;
  }

  static create(
    params: Omit<AuditEventProps, 'eventHash' | 'createdAt'> & {
      createdAt?: Date;
    },
  ): AuditEvent {
    const createdAt = params.createdAt ?? new Date();
    const eventHash = AuditEvent.computeHash({
      eventId: params.eventId,
      eventType: params.eventType,
      eventPayload: params.eventPayload,
      previousEventHash: params.previousEventHash,
      createdAt,
    });
    return new AuditEvent({ ...params, createdAt, eventHash });
  }

  static reconstitute(props: AuditEventProps): AuditEvent {
    return new AuditEvent(props);
  }

  static computeHash(input: {
    eventId: string;
    eventType: string;
    eventPayload: Record<string, unknown>;
    previousEventHash: string | null;
    createdAt: Date;
  }): string {
    const material =
      input.eventId +
      input.eventType +
      JSON.stringify(input.eventPayload) +
      (input.previousEventHash ?? '') +
      input.createdAt.toISOString();
    return createHash('sha256').update(material).digest('hex');
  }

  /** Recomputes the hash from this event's own fields and compares to the stored hash. */
  verifyOwnIntegrity(): boolean {
    const recomputed = AuditEvent.computeHash({
      eventId: this.props.eventId,
      eventType: this.props.eventType,
      eventPayload: this.props.eventPayload,
      previousEventHash: this.props.previousEventHash,
      createdAt: this.props.createdAt,
    });
    return recomputed === this.props.eventHash;
  }

  get eventHash(): string {
    return this.props.eventHash;
  }

  get previousEventHash(): string | null {
    return this.props.previousEventHash;
  }

  toProps(): Readonly<AuditEventProps> {
    return { ...this.props };
  }
}
