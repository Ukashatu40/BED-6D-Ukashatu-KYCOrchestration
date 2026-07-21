// src/api/kyc/dto/initiate-kyc.dto.ts
import { IsBoolean, IsNumber, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class InitiateKycRequestDto {
  @ApiProperty() @IsNumber() @Min(0) loanAmountInr!: number;
  @ApiProperty() @IsBoolean() isPep!: boolean;
  @ApiProperty() @IsBoolean() isHighRiskJurisdiction!: boolean;
}
