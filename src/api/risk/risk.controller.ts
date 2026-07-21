// src/api/risk/risk.controller.ts
import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RecalculateRiskScoreUseCase } from '../../application/use-cases/recalculate-risk-score.use-case';
import { GetRiskScoreUseCase } from '../../application/use-cases/get-risk-score.use-case';
import { CustomerRepositoryPort } from '../../application/ports/customer-repository.port';
import { AuditTrailPort } from '../../application/ports/audit-trail.port';
import { CUSTOMER_REPOSITORY, AUDIT_TRAIL_PORT } from '../../infrastructure/persistence/tokens';
import { RecalculateRiskRequestDto } from './dto/recalculate-risk.dto';
import { CurrentUser } from '../auth/current-user.decorator';
import { CorrelationId } from '../correlation-id.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { Roles } from '../auth/roles.decorator';

/**
 * Deliberately thin: every method is authenticate (handled by the global
 * JwtAuthGuard/RolesGuard) -> validate (handled by the DTO + global
 * ValidationPipe) -> invoke use case -> return standardised response. No
 * branching, no try/catch — error mapping is centralised in
 * DomainExceptionFilter. If a method here starts growing an `if`
 * statement that isn't purely about extracting a response shape, that's a
 * signal the logic belongs in a use case instead.
 */
@ApiTags('risk')
@ApiBearerAuth()
@Controller('api/v1/risk')
export class RiskController {
  constructor(
    @Inject(CUSTOMER_REPOSITORY) private readonly customerRepository: CustomerRepositoryPort,
    @Inject(AUDIT_TRAIL_PORT) private readonly auditTrail: AuditTrailPort,
  ) {}

  @Get('customer/:customerId/score')
  @Roles('compliance_officer', 'ops_admin', 'system')
  @ApiOperation({ summary: 'Current risk score with factor breakdown' })
  @ApiParam({ name: 'customerId' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404 })
  async getScore(@Param('customerId') customerId: string) {
    const useCase = new GetRiskScoreUseCase(this.customerRepository);
    return useCase.execute(customerId);
  }

  @Post('customer/:customerId/recalculate')
  @Roles('compliance_officer', 'ops_admin', 'system')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Force risk score recalculation' })
  @ApiParam({ name: 'customerId' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 400 })
  @ApiResponse({ status: 404 })
  async recalculate(
    @Param('customerId') customerId: string,
    @Body() body: RecalculateRiskRequestDto,
    @CurrentUser() user: JwtPayload,
    @CorrelationId() correlationId: string,
  ) {
    const useCase = new RecalculateRiskScoreUseCase(this.customerRepository, this.auditTrail);
    const command =
      body.kind === 'FULL_RECALCULATION'
        ? {
            kind: 'FULL_RECALCULATION' as const,
            customerId,
            factors: body.factors!,
            actorId: user.sub,
            actorType: user.actorType,
            correlationId,
          }
        : {
            kind: 'DELTA_APPLICATION' as const,
            customerId,
            deltas: body.deltas!,
            actorId: user.sub,
            actorType: user.actorType,
            correlationId,
          };
    const result = await useCase.execute(command);
    return { ...result, correlationId };
  }
}
