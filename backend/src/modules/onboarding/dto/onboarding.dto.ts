import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean, IsEnum, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, Matches,
  Max, MaxLength, Min,
} from 'class-validator';

import { CM_PHONE_REGEX } from '../../auth/dto/auth.dto';

export class UpdateProfileDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) fullName?: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional() @IsObject() professionalAddress?: Record<string, unknown>;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional() @IsObject() personalAddress?: Record<string, unknown>;
  @ApiPropertyOptional({ type: [String], example: ['criminal', 'corporate'] })
  @IsOptional() specialization?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() lawFirmId?: string;

  @ApiPropertyOptional({ description: 'Stored encrypted; only ever returned masked' })
  @IsOptional() @IsString() @MaxLength(50) nationalIdNo?: string;

  @ApiPropertyOptional({ description: 'Stored encrypted; only ever returned masked' })
  @IsOptional() @IsString() @MaxLength(50) passportNo?: string;
}

export class VerificationDecisionDto {
  @ApiProperty({ enum: ['verified', 'rejected'] })
  @IsEnum(['verified', 'rejected'])
  decision!: 'verified' | 'rejected';

  @ApiPropertyOptional({ description: 'Required when rejecting; shown to the applicant' })
  @IsOptional() @IsString() @MaxLength(500) reason?: string;

  @ApiPropertyOptional({
    type: 'object', additionalProperties: true,
    description: 'What the Bar register held at decision time, kept as evidence',
  })
  @IsOptional() @IsObject() registrySnapshot?: Record<string, unknown>;
}

export class CreateBeneficiaryDto {
  @ApiProperty({ example: 'Estelle ANGO' })
  @IsString() @IsNotEmpty() @MaxLength(200) fullName!: string;

  @ApiProperty({ enum: ['spouse', 'child', 'parent', 'dependent'] })
  @IsEnum(['spouse', 'child', 'parent', 'dependent'])
  relationship!: 'spouse' | 'child' | 'parent' | 'dependent';

  @ApiProperty({ example: '1990-04-12' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dateOfBirth must be an ISO date (YYYY-MM-DD)' })
  dateOfBirth!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(50) nationalIdNo?: string;

  @ApiPropertyOptional({ example: '+237670123456' })
  @IsOptional() @Matches(CM_PHONE_REGEX, { message: 'Phone must be a Cameroonian mobile' })
  phone?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional() @IsBoolean() medicalCoverage?: boolean;
}

export class CreateVehicleDto {
  @ApiProperty({ example: 'CE-234-AB' })
  @IsString() @IsNotEmpty() @MaxLength(20) registrationNumber!: string;

  @ApiProperty({ example: 'JTEBU29J885123456' })
  @IsString() @IsNotEmpty() @MaxLength(30) chassisNumber!: string;

  @ApiProperty({ example: '2TR1234567' })
  @IsString() @IsNotEmpty() @MaxLength(30) engineNumber!: string;

  @ApiProperty({ example: 'Toyota' })
  @IsString() @IsNotEmpty() @MaxLength(50) make!: string;

  @ApiProperty({ example: 'Hilux' })
  @IsString() @IsNotEmpty() @MaxLength(50) model!: string;

  @ApiProperty({ example: 2019, minimum: 1950 })
  @IsInt() @Min(1950) @Max(new Date().getFullYear() + 1) year!: number;

  @ApiProperty({
    example: '18500000',
    description: 'Declared value in whole XAF francs. Sent as a string — see the money note in the API description.',
  })
  @Matches(/^\d+$/, { message: 'valueXaf must be a whole number of francs' })
  valueXaf!: string;

  @ApiPropertyOptional({ example: 5 })
  @IsOptional() @IsInt() @Min(1) @Max(80) seats?: number;

  @ApiPropertyOptional({ enum: ['private', 'professional'], default: 'private' })
  @IsOptional() @IsEnum(['private', 'professional']) usage?: string;
}
