// src/api/auth/jwt-payload.interface.ts
import { AuditActorType } from '../../domain/entities/audit-event.entity';

export interface JwtPayload {
  sub: string; // actor ID (user ID, service account ID, etc.)
  actorType: AuditActorType;
  roles: string[];
  correlationId?: string; // optional — a fresh one is generated per-request if absent, see CorrelationIdInterceptor
}
