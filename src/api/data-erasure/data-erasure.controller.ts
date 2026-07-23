// src/api/data-erasure/data-erasure.controller.ts
import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { RequestDataErasureUseCase } from '../../application/use-cases/request-data-erasure.use-case';
import { DataErasureRepositoryPort } from '../../application/ports/data-erasure-repository.port';
import { CurrentUser } from '../auth/current-user.decorator';
import { CorrelationId } from '../correlation-id.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { Roles } from '../auth/roles.decorator';
import { DATA_ERASURE_REPOSITORY } from '../shared.tokens';

class DataErasureRequestDto {
  @ApiProperty() @IsUUID() customerId!: string;
  @ApiProperty({ required: false, type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  relationshipEndDate?: Date;
  @ApiProperty() @IsBoolean() hasActiveLoans!: boolean;
  @ApiProperty() @IsBoolean() hasOpenInvestigations!: boolean;
  @ApiProperty() @IsBoolean() hasPendingLitigation!: boolean;
}

@ApiTags('data-erasure')
@ApiBearerAuth()
@Controller('api/v1/data')
export class DataErasureController {
  constructor(
    @Inject('RequestDataErasureUseCase') private readonly requestErasure: RequestDataErasureUseCase,
    @Inject(DATA_ERASURE_REPOSITORY) private readonly erasureRepository: DataErasureRepositoryPort,
  ) {}

  @Post('erasure-request')
  @Roles('compliance_officer', 'customer')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit DPDP Act erasure request' })
  @ApiResponse({ status: 201 })
  async submit(
    @Body() body: DataErasureRequestDto,
    @CurrentUser() user: JwtPayload,
    @CorrelationId() correlationId: string,
  ) {
    return this.requestErasure.execute({
      customerId: body.customerId,
      requestorId: user.sub,
      relationshipEndDate: body.relationshipEndDate ?? null,
      hasActiveLoans: body.hasActiveLoans,
      hasOpenInvestigations: body.hasOpenInvestigations,
      hasPendingLitigation: body.hasPendingLitigation,
      actorId: user.sub,
      actorType: user.actorType,
      correlationId,
    });
  }

  @Get('erasure-request/:requestId')
  @Roles('compliance_officer', 'customer')
  @ApiOperation({ summary: 'Check erasure request status' })
  @ApiParam({ name: 'requestId' })
  async status(@Param('requestId') requestId: string) {
    return this.erasureRepository.findById(requestId);
  }
}
