/* eslint-disable @typescript-eslint/no-unsafe-member-access */
// src/api/aml/aml.controller.ts
import { Body, Controller, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DisposeAmlAlertUseCase } from '../../application/use-cases/dispose-aml-alert.use-case';
import { DisposeAlertRequestDto } from './dto/dispose-alert.dto';
import { CurrentUser } from '../auth/current-user.decorator';
import { CorrelationId } from '../correlation-id.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { Roles } from '../auth/roles.decorator';

@ApiTags('aml')
@ApiBearerAuth()
@Controller('api/v1/aml')
export class AmlController {
  constructor(
    @Inject('DisposeAmlAlertUseCase') private readonly disposeAlert: DisposeAmlAlertUseCase,
  ) {}

  @Post(':matchId/dispose')
  @Roles('compliance_officer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dispose an AML alert (clear/escalate)' })
  @ApiParam({ name: 'matchId' })
  @ApiResponse({ status: 200 })
  @ApiResponse({
    status: 400,
    description: 'Justification under 50 characters, or invalid disposition value',
  })
  @ApiResponse({ status: 404 })
  async dispose(
    @Param('matchId') matchId: string,
    @Body() body: DisposeAlertRequestDto,
    @CurrentUser() user: JwtPayload,
    @CorrelationId() correlationId: string,
  ) {
    await this.disposeAlert.execute({
      matchId,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      disposition: body.disposition,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      justification: body.justification,
      actorId: user.sub,
      actorType: user.actorType,
      correlationId,
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    return { matchId, disposition: body.disposition, correlationId };
  }
}
