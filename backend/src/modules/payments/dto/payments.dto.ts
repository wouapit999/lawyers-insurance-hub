import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import { CM_PHONE_REGEX } from '../../auth/dto/auth.dto';

export class PayInstallmentDto {
  @ApiProperty({ enum: ['orange_money', 'mtn_momo', 'card', 'bank_transfer'] })
  @IsEnum(['orange_money', 'mtn_momo', 'card', 'bank_transfer'])
  provider!: 'orange_money' | 'mtn_momo' | 'card' | 'bank_transfer';

  @ApiPropertyOptional({
    example: '+237670123456',
    description: 'Payer’s wallet number. Required for Orange Money and MTN MoMo.',
  })
  @IsOptional()
  @Matches(CM_PHONE_REGEX, { message: 'Wallet number must be a Cameroonian mobile' })
  msisdn?: string;
}

export class PayClaimDto {
  @ApiProperty({ enum: ['orange_money', 'mtn_momo'] })
  @IsEnum(['orange_money', 'mtn_momo'])
  provider!: 'orange_money' | 'mtn_momo';

  @ApiProperty({ example: '+237670123456', description: 'Claimant’s wallet' })
  @Matches(CM_PHONE_REGEX, { message: 'Wallet number must be a Cameroonian mobile' })
  msisdn!: string;
}

export class RefundDto {
  @ApiPropertyOptional({
    example: '71250',
    description: 'Whole XAF francs. Omit to refund the full remaining balance.',
  })
  @IsOptional()
  @Matches(/^\d+$/, { message: 'amountXaf must be a whole number of francs' })
  amountXaf?: string;

  @ApiProperty({ description: 'Recorded on the audit trail and the ledger entry' })
  @IsString() @IsNotEmpty() @MaxLength(500)
  reason!: string;
}
