// src/api/risk/dto/recalculate-risk.dto.ts
import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsString,
  Max,
  Min,
  MinLength,
  registerDecorator,
  ValidateIf,
  ValidateNested,
  ValidationOptions,
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
  @ApiProperty({ minLength: 10 }) @IsString() @MinLength(10) reason!: string;
  @ApiProperty() @IsInt() points!: number;
}

/** Declarative cross-field validator so "factors required iff kind===FULL_RECALCULATION" lives in the DTO, not in controller logic. */
function RequiredWhenKindIs(kind: string, validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'requiredWhenKindIs',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown, args) {
          if (!args) return true; // defensive — validator framework always supplies this at runtime
          const dto = args.object as RecalculateRiskRequestDto;
          if (dto.kind !== kind) return true;
          return value !== undefined && value !== null;
        },
        defaultMessage(args) {
          return args
            ? `${args.property} is required when kind is "${kind}"`
            : 'This field is required';
        },
      },
    });
  };
}

export class RecalculateRiskRequestDto {
  @ApiProperty({ enum: ['FULL_RECALCULATION', 'DELTA_APPLICATION'] })
  @IsIn(['FULL_RECALCULATION', 'DELTA_APPLICATION'])
  kind!: 'FULL_RECALCULATION' | 'DELTA_APPLICATION';

  @ApiProperty({ required: false, type: RiskFactorInputsDto })
  @RequiredWhenKindIs('FULL_RECALCULATION')
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  @ValidateIf((dto) => dto.kind === 'FULL_RECALCULATION')
  @ValidateNested()
  @Type(() => RiskFactorInputsDto)
  factors?: RiskFactorInputsDto;

  @ApiProperty({ required: false, type: [RiskDeltaDto] })
  @RequiredWhenKindIs('DELTA_APPLICATION')
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  @ValidateIf((dto) => dto.kind === 'DELTA_APPLICATION')
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RiskDeltaDto)
  deltas?: RiskDeltaDto[];
}
