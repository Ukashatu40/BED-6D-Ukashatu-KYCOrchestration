// src/api/correlation-id.middleware.ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Assigns one correlation ID per incoming request (UUID v4, per the
 * spec's Correlation ID propagation requirement, p.45), attached to
 * request.correlationId. Runs before guards/controllers so it's available
 * even on requests that get rejected by JwtAuthGuard — an auth failure
 * still needs a correlation ID in its error response.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(
    req: FastifyRequest['raw'] & { correlationId?: string },
    _res: FastifyReply['raw'],
    next: () => void,
  ): void {
    req.correlationId = randomUUID();
    next();
  }
}
