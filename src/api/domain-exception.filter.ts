// src/api/domain-exception.filter.ts
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { CustomerNotFoundError } from '../application/use-cases/recalculate-risk-score.use-case';
import { VendorNormalisedError } from '../application/ports/internal-error';
import { HTTP_STATUS_BY_CATEGORY } from '../application/ports/internal-error';
import { InvalidTransitionError } from '../domain/state-machine/verification-state-machine';

/**
 * Single point where every domain/application-layer error thrown by a use
 * case is translated into the spec's standardised Error Response Envelope
 * (p.39): { error: { code, message, details?, correlationId, timestamp } }.
 * This is what lets controllers stay free of try/catch entirely — they
 * just call the use case and let errors propagate; this filter is the only
 * place HTTP status codes and response shape are decided. New domain error
 * types are added here as one more `if` branch, never as new try/catch
 * blocks scattered across controllers.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<{ correlationId?: string }>();
    const correlationId = request.correlationId ?? 'unknown';
    const timestamp = new Date().toISOString();

    if (exception instanceof HttpException) {
      // Guards (UnauthorizedException, ForbiddenException, BadRequestException
      // from ValidationPipe) already produce a { error: {...} } body — just
      // ensure correlationId/timestamp are present and pass the status through.
      const body = exception.getResponse();
      const errorBody =
        typeof body === 'object' && body !== null && 'error' in body
          ? (body as { error: Record<string, unknown> }).error
          : { code: 'HTTP_ERROR', message: exception.message };
      response.status(exception.getStatus()).send({
        error: { ...errorBody, correlationId, timestamp },
      });
      return;
    }

    if (exception instanceof CustomerNotFoundError) {
      response.status(HttpStatus.NOT_FOUND).send({
        error: { code: 'NOT_FOUND', message: exception.message, correlationId, timestamp },
      });
      return;
    }

    if (exception instanceof VendorNormalisedError) {
      response.status(HTTP_STATUS_BY_CATEGORY[exception.category]).send({
        error: {
          code: exception.category,
          message: `Vendor operation failed (${exception.vendorType})`, // never expose exception.vendorErrorCode raw per spec p.39: "Never expose vendor-specific error codes"
          correlationId,
          timestamp,
        },
      });
      return;
    }

    if (exception instanceof InvalidTransitionError) {
      response.status(HttpStatus.CONFLICT).send({
        error: {
          code: 'CONFLICT',
          message: exception.message,
          details: [
            {
              field: 'status',
              reason: `Allowed events: ${exception.allowedEvents.join(', ') || '(none)'}`,
            },
          ],
          correlationId,
          timestamp,
        },
      });
      return;
    }

    // Unhandled — per spec p.39/p.40: generic message to the client, full
    // detail logged server-side only (structured logging is Day 6+ scope;
    // console.error here is the interim until that lands).
    console.error(`[UNHANDLED] correlationId=${correlationId}`, exception);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        correlationId,
        timestamp,
      },
    });
  }
}
