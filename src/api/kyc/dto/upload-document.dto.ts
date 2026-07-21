// src/api/kyc/dto/upload-document.dto.ts
import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { DocumentType } from '../../../domain/value-objects/document-type.enum';

export class UploadDocumentRequestDto {
  @ApiProperty({ enum: DocumentType }) @IsEnum(DocumentType) documentType!: DocumentType;
  // Multipart file bytes are handled via Fastify's multipart plugin at the
  // controller parameter level (@UploadedFile()), not as a DTO field —
  // wired in the controller below.
}
