// src/api/risk/dto/recalculate-risk.dto.ts
import {
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsString,
  Max,
  Min,
  ValidateNested,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class RiskFactorInputsDto {
  @ApiProperty({ minimum: 0, maximum: 100 }) @IsNumber() @Min(0) @Max(100) productType!: number;
  @ApiProperty({ minimum: 0, maximum: 100 })
  @IsNumber()
  @Min(0)
  @Max(100)
  transactionAnomaly!: number;
  @ApiProperty({ minimum: 0, maximum: 100 })
  @IsNumber()
  @Min(0)
  @Max(100)
  jurisdictionalRisk!: number;
  @ApiProperty({ minimum: 0, maximum: 100 }) @IsNumber() @Min(0) @Max(100) pepStatus!: number;
  @ApiProperty({ minimum: 0, maximum: 100 }) @IsNumber() @Min(0) @Max(100) amlResults!: number;
}

export class RiskDeltaDto {
  @ApiProperty({
    minLength: 10,
    description: 'Human-readable reason for this point delta — required for audit traceability',
  })
  @IsString()
  @MinLength(10)
  reason!: string;

  @ApiProperty({ description: 'Signed integer point adjustment; positive increases risk' })
  @IsInt()
  points!: number;
}

export class RecalculateRiskRequestDto {
  @ApiProperty({ enum: ['FULL_RECALCULATION', 'DELTA_APPLICATION'] })
  @IsIn(['FULL_RECALCULATION', 'DELTA_APPLICATION'])
  kind!: 'FULL_RECALCULATION' | 'DELTA_APPLICATION';

  @ApiProperty({ required: false, type: RiskFactorInputsDto })
  @ValidateNested()
  @Type(() => RiskFactorInputsDto)
  factors?: RiskFactorInputsDto;

  @ApiProperty({ required: false, type: [RiskDeltaDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RiskDeltaDto)
  deltas?: RiskDeltaDto[];
}
