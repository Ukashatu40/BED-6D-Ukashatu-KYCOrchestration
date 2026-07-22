// src/api/aml/dto/dispose-alert.dto.ts
import { IsIn, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MIN_JUSTIFICATION_LENGTH } from '../../../application/use-cases/dispose-aml-alert.use-case';
import { AlertDisposition } from '../../../application/use-cases/dispose-aml-alert.use-case';

export class DisposeAlertRequestDto {
  @ApiProperty({ enum: ['CLEARED', 'ESCALATED'] })
  @IsIn(['CLEARED', 'ESCALATED'])
  disposition!: AlertDisposition;

  @ApiProperty({ minLength: MIN_JUSTIFICATION_LENGTH })
  @IsString()
  @MinLength(MIN_JUSTIFICATION_LENGTH, {
    message: `justification must be at least ${MIN_JUSTIFICATION_LENGTH} characters`,
  })
  justification!: string;
}
