// src/api/webhooks/webhooks.controller.ts
import {
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { ProcessWebhookUseCase } from '../../application/use-cases/process-webhook.use-case';
import { VendorType, WebhookPayload } from '../../application/ports/kyc-vendor.port';
import { Public } from '../auth/public.decorator';

interface WebhookRequestWithRawBody extends FastifyRequest {
  rawBody?: Buffer;
}

/**
 * Vendor webhook endpoints per Section D.3.2's table. @Public() since
 * these authenticate via per-vendor HMAC signature (verified inside the
 * adapter's handleCallback, per Day 2), not JWT — a vendor calling back
 * has no user session to present a bearer token for.
 *
 * requestId resolution (mapping a vendor's session/reference ID to our
 * internal VerificationRequest.requestId) is flagged as an open item on
 * ProcessWebhookUseCase's own docstring — this controller currently
 * expects the caller to have already resolved it via a path/query
 * parameter, which in a real deployment would come from a
 * VendorReferenceIndex lookup this project's timeline doesn't reach.
 */
@ApiTags('webhooks')
@Controller('webhooks/v1')
export class WebhooksController {
  constructor(
    @Inject('ProcessWebhookUseCase') private readonly processWebhook: ProcessWebhookUseCase,
  ) {}

  @Post('video-kyc/callback')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'SigniVision session.completed/failed/expired webhook' })
  async videoKycCallback(@Req() req: RawBodyRequest<WebhookRequestWithRawBody>) {
    return this.handle(VendorType.VIDEO_KYC, req);
  }

  @Post('aml/monitoring-alert')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'GlobalWatch monitoring.new_match/list_updated webhook' })
  async amlMonitoringAlert(@Req() req: RawBodyRequest<WebhookRequestWithRawBody>) {
    return this.handle(VendorType.AML_SCREENING, req);
  }

  @Post('ckyc/upload-status')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'CERSAI upload.confirmed/rejected/record.updated webhook' })
  async ckycUploadStatus(@Req() req: RawBodyRequest<WebhookRequestWithRawBody>) {
    return this.handle(VendorType.CKYC, req);
  }

  private async handle(vendorType: VendorType, req: RawBodyRequest<WebhookRequestWithRawBody>) {
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
    const headers = req.headers as Record<string, string>;
    const signature = headers['x-signature'] ?? headers['x-hmac-signature'] ?? '';
    const parsedBody = JSON.parse(rawBody.toString('utf-8'));

    const payload: WebhookPayload = {
      vendorType,
      eventId: parsedBody.eventId ?? randomUUID(),
      eventType: parsedBody.event ?? 'unknown',
      signature,
      rawBody,
      headers,
    };

    // requestId resolution gap — see class-level note. Placeholder until
    // a VendorReferenceIndex exists; a header/query param carries it for
    // now so the wiring is demonstrable end to end.
    const requestId = headers['x-request-id'] ?? parsedBody.requestId;

    const result = await this.processWebhook.execute({
      vendorType,
      requestId,
      payload,
      actorId: `webhook-${vendorType.toLowerCase()}`,
      correlationId: randomUUID(),
    });

    return { received: true, wasDuplicate: result.wasDuplicate };
  }
}
