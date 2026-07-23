// src/api/kyc/kyc.controller.ts
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  //   Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InitiateKycUseCase } from '../../application/use-cases/initiate-kyc.use-case';
import { UploadKycDocumentUseCase } from '../../application/use-cases/upload-kyc-document.use-case';
import { GetKycStatusUseCase } from '../../application/use-cases/get-kyc-status.use-case';
import { GetKycHistoryUseCase } from '../../application/use-cases/get-kyc-history.use-case';
import { InitiateKycRequestDto } from './dto/initiate-kyc.dto';
import { CurrentUser } from '../auth/current-user.decorator';
import { CorrelationId } from '../correlation-id.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { Roles } from '../auth/roles.decorator';
import { DocumentType } from '../../domain/value-objects/document-type.enum';
import { EscalateKycTierUseCase } from '../../application/use-cases/escalate-kyc-tier.use-case';

/**
 * Thin per the same discipline as RiskController: every method is
 * authenticate (global guards) -> validate (DTOs) -> invoke exactly one
 * use case -> return. All orchestration (tier selection, state machine
 * driving, workflow execution) lives in the use cases built above; none of
 * it belongs here.
 */
@ApiTags('kyc')
@ApiBearerAuth()
@Controller('api/v1/kyc')
export class KycController {
  constructor(
    @Inject('InitiateKycUseCase') private readonly initiateKyc: InitiateKycUseCase,
    @Inject('UploadKycDocumentUseCase') private readonly uploadDocument: UploadKycDocumentUseCase,
    @Inject('GetKycStatusUseCase') private readonly getStatus: GetKycStatusUseCase,
    @Inject('GetKycHistoryUseCase') private readonly getHistory: GetKycHistoryUseCase,
    @Inject('EscalateKycTierUseCase') private readonly escalateTier: EscalateKycTierUseCase,
  ) {}

  @Post('initiate')
  @Roles('ops_admin', 'system')
  @ApiOperation({ summary: 'Start new KYC verification for a customer' })
  @ApiResponse({ status: 201 })
  async initiate(
    @Body() body: InitiateKycRequestDto & { customerId: string },
    @CurrentUser() user: JwtPayload,
    @CorrelationId() correlationId: string,
  ) {
    return this.initiateKyc.execute({
      customerId: body.customerId,
      loanAmountInr: body.loanAmountInr,
      isPep: body.isPep,
      isHighRiskJurisdiction: body.isHighRiskJurisdiction,
      actorId: user.sub,
      actorType: user.actorType,
      correlationId,
    });
  }

  @Get(':requestId/status')
  @Roles('ops_admin', 'compliance_officer', 'system', 'customer')
  @ApiOperation({ summary: 'Check current verification status and progress' })
  @ApiParam({ name: 'requestId' })
  async status(@Param('requestId') requestId: string) {
    return this.getStatus.execute(requestId);
  }

  @Post(':requestId/documents')
  @Roles('ops_admin', 'system', 'customer')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Upload identity document (multipart)' })
  @ApiParam({ name: 'requestId' })
  async uploadDoc(
    @Param('requestId') requestId: string,
    @Body() body: { customerId: string; documentType: DocumentType; fileBase64: string },
    @CurrentUser() user: JwtPayload,
    @CorrelationId() correlationId: string,
  ) {
    // NOTE: multipart file handling (@fastify/multipart registration,
    // streaming large files rather than base64-in-JSON) is Day 6+
    // hardening — this signature accepts base64 for now to keep the use
    // case wiring demonstrable without pulling in the multipart plugin
    // mid-Day-5. Flagging explicitly rather than presenting this as the
    // final production request shape.
    return this.uploadDocument.execute({
      requestId,
      customerId: body.customerId,
      documentType: body.documentType,
      fileBytes: Buffer.from(body.fileBase64, 'base64'),
      actorId: user.sub,
      actorType: user.actorType,
      correlationId,
    });
  }

  @Get('customer/:customerId/history')
  @Roles('ops_admin', 'compliance_officer', 'system')
  @ApiOperation({ summary: 'Complete verification history for a customer' })
  @ApiParam({ name: 'customerId' })
  async history(@Param('customerId') customerId: string) {
    return this.getHistory.execute(customerId);
  }

  @Post(':requestId/escalate')
  @Roles('compliance_officer', 'ops_admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manual escalation to higher KYC tier' })
  @ApiParam({ name: 'requestId' })
  async escalate(
    @Param('requestId') requestId: string,
    @Body()
    body: {
      targetTier: import('../../domain/value-objects/kyc-tier.enum').KycTier;
      reason: string;
    },
    @CurrentUser() user: JwtPayload,
    @CorrelationId() correlationId: string,
  ) {
    return this.escalateTier.execute({
      requestId,
      targetTier: body.targetTier,
      reason: body.reason,
      actorId: user.sub,
      actorType: user.actorType,
      correlationId,
    });
  }
}
