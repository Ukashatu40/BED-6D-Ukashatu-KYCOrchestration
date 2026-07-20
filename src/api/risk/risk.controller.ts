// src/api/risk/risk.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'crypto';
import {
  CustomerNotFoundError,
  RecalculateRiskScoreUseCase,
} from '../../application/use-cases/recalculate-risk-score.use-case';
import { CustomerRepositoryPort } from '../../application/ports/customer-repository.port';
import { CUSTOMER_REPOSITORY, AUDIT_TRAIL_PORT } from '../../infrastructure/persistence/tokens';
import { AuditTrailPort } from '../../application/ports/audit-trail.port';
import { AuditActorType } from '../../domain/entities/audit-event.entity';
import { RecalculateRiskRequestDto } from './dto/recalculate-risk.dto';

@ApiTags('risk')
@Controller('api/v1/risk')
export class RiskController {
  private readonly useCase: RecalculateRiskScoreUseCase;

  constructor(
    @Inject(CUSTOMER_REPOSITORY) customerRepository: CustomerRepositoryPort,
    @Inject(AUDIT_TRAIL_PORT) auditTrail: AuditTrailPort,
  ) {
    this.useCase = new RecalculateRiskScoreUseCase(customerRepository, auditTrail);
  }

  @Get('customer/:customerId/score')
  @ApiOperation({ summary: 'Current risk score with factor breakdown' })
  @ApiParam({ name: 'customerId' })
  @ApiResponse({ status: 200, description: 'Current risk score' })
  @ApiResponse({ status: 404, description: 'Customer not found' })
  async getScore(
    @Param('customerId') customerId: string,
    @Inject(CUSTOMER_REPOSITORY) customerRepository: CustomerRepositoryPort,
  ) {
    const customer = await customerRepository.findById(customerId);
    if (!customer) {
      throw new NotFoundException({
        error: {
          code: 'NOT_FOUND',
          message: `No customer found with ID ${customerId}`,
          correlationId: randomUUID(),
          timestamp: new Date().toISOString(),
        },
      });
    }
    const props = customer.toProps();
    return {
      customerId: props.customerId,
      riskScore: props.riskScore.getValue(),
      riskFactors: props.riskFactors,
      exceedsEddThreshold: props.riskScore.exceedsEddThreshold(),
    };
  }

  @Post('customer/:customerId/recalculate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Force risk score recalculation' })
  @ApiParam({ name: 'customerId' })
  @ApiResponse({ status: 200, description: 'Recalculation result' })
  @ApiResponse({
    status: 400,
    description: 'Validation error — missing factors/deltas for the given kind',
  })
  @ApiResponse({ status: 404, description: 'Customer not found' })
  async recalculate(
    @Param('customerId') customerId: string,
    @Body() body: RecalculateRiskRequestDto,
  ) {
    const correlationId = randomUUID();

    if (body.kind === 'FULL_RECALCULATION' && !body.factors) {
      throw this.validationError(
        'factors is required when kind is FULL_RECALCULATION',
        correlationId,
      );
    }
    if (body.kind === 'DELTA_APPLICATION' && (!body.deltas || body.deltas.length === 0)) {
      throw this.validationError(
        'deltas (non-empty array) is required when kind is DELTA_APPLICATION',
        correlationId,
      );
    }

    try {
      const result =
        body.kind === 'FULL_RECALCULATION'
          ? await this.useCase.execute({
              kind: 'FULL_RECALCULATION',
              customerId,
              factors: body.factors!,
              actorId: 'api-caller', // real actor identity comes from the JWT once auth middleware lands — see Day 5's remaining API-layer task list
              actorType: AuditActorType.USER,
              correlationId,
            })
          : await this.useCase.execute({
              kind: 'DELTA_APPLICATION',
              customerId,
              deltas: body.deltas!,
              actorId: 'api-caller',
              actorType: AuditActorType.USER,
              correlationId,
            });

      return { ...result, correlationId };
    } catch (err) {
      if (err instanceof CustomerNotFoundError) {
        throw new NotFoundException({
          error: {
            code: 'NOT_FOUND',
            message: err.message,
            correlationId,
            timestamp: new Date().toISOString(),
          },
        });
      }
      throw err;
    }
  }

  private validationError(message: string, correlationId: string): BadRequestException {
    return new BadRequestException({
      error: {
        code: 'VALIDATION_ERROR',
        message,
        correlationId,
        timestamp: new Date().toISOString(),
      },
    });
  }
}
