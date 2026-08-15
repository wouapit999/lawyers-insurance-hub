import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString, IsNotEmpty, IsObject, IsOptional, IsString, Matches, MaxLength,
} from 'class-validator';

export class FileClaimDto {
  @ApiProperty({ description: 'The active policy the claim is made against' })
  @IsString() @IsNotEmpty() policyId!: string;

  @ApiProperty({ example: '2026-08-12T14:30:00Z', description: 'When the incident occurred' })
  @IsDateString() incidentAt!: string;

  @ApiProperty({ example: 'Carrefour Warda, Douala' })
  @IsOptional() @IsString() @MaxLength(300) incidentPlace?: string;

  @ApiPropertyOptional({
    type: 'object', additionalProperties: true,
    example: { lat: 4.0511, lng: 9.7679 },
    description: 'Pre-filled by the mobile app from the device GPS',
  })
  @IsOptional() @IsObject() incidentGeo?: Record<string, unknown>;

  @ApiProperty({ example: 'Rear-ended at a junction; rear bumper and boot damaged.' })
  @IsString() @IsNotEmpty() @MaxLength(5000) description!: string;

  @ApiPropertyOptional({ example: '1450000', description: 'Amount claimed, whole XAF francs' })
  @IsOptional() @Matches(/^\d+$/, { message: 'claimedXaf must be a whole number of francs' })
  claimedXaf?: string;
}

export class TransitionClaimDto {
  @ApiPropertyOptional({ description: 'Mandatory when rejecting. Written to the evidence trail.' })
  @IsOptional() @IsString() @MaxLength(2000) note?: string;

  @ApiPropertyOptional({ example: '900000', description: 'Indemnity approved, whole XAF francs' })
  @IsOptional() @Matches(/^\d+$/, { message: 'approvedXaf must be a whole number of francs' })
  approvedXaf?: string;

  @ApiPropertyOptional({ description: 'Reassign the claim to another officer' })
  @IsOptional() @IsString() assignToId?: string;
}
