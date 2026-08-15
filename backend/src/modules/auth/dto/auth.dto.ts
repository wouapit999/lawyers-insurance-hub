import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean, IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString, Length, Matches,
  MaxLength, MinLength,
} from 'class-validator';

/**
 * Cameroonian mobile numbers in E.164: +237 then 6 then 8 digits.
 * Accepting anything looser means an OTP that silently never arrives, which
 * looks to the user like the app is broken.
 */
export const CM_PHONE_REGEX = /^\+237[62]\d{8}$/;

export class RegisterDto {
  @ApiProperty({ example: 'me.ango@cabinet-ango.cm' })
  @IsEmail({}, { message: 'A valid email address is required' })
  @MaxLength(255)
  email!: string;

  @ApiProperty({ example: '+237670123456', description: 'Cameroonian mobile, E.164' })
  @Matches(CM_PHONE_REGEX, {
    message: 'Phone number must be a Cameroonian mobile in the form +2376XXXXXXXX',
  })
  phone!: string;

  @ApiProperty({
    example: 'Corr3ct-Horse-Battery',
    description:
      'At least 12 characters. Length is the requirement rather than a ' +
      'character-class rule, because length is what actually resists ' +
      'offline cracking and rules mostly produce Password1!.',
  })
  @IsString()
  @MinLength(12, { message: 'Password must be at least 12 characters' })
  @MaxLength(128)
  password!: string;

  @ApiProperty({ example: 'Marie ANGO NKOLO' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  fullName!: string;

  @ApiProperty({ example: 'CM/BAR/2016/0412', description: 'Cameroon Bar registration number' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  barNumber!: string;

  @ApiProperty({ example: '2016-11-18', description: 'Date of admission to the Bar (ISO)' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'admittedOn must be an ISO date (YYYY-MM-DD)' })
  admittedOn!: string;

  @ApiPropertyOptional({ enum: ['en', 'fr'], default: 'fr' })
  @IsOptional()
  @IsEnum(['en', 'fr'])
  preferredLang?: 'en' | 'fr';
}

export class LoginDto {
  @ApiProperty({ example: 'me.ango@cabinet-ango.cm' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Corr3ct-Horse-Battery' })
  @IsString()
  @IsNotEmpty()
  password!: string;

  @ApiPropertyOptional({
    description: 'Stable per-install identifier. Enables device recognition and step-up on new devices.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  deviceFingerprint?: string;

  @ApiPropertyOptional({ example: 'iPhone 14 — Douala' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceLabel?: string;

  @ApiPropertyOptional({ enum: ['ios', 'android', 'web', 'desktop'] })
  @IsOptional()
  @IsEnum(['ios', 'android', 'web', 'desktop'])
  platform?: 'ios' | 'android' | 'web' | 'desktop';
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class RequestOtpDto {
  @ApiProperty({ enum: ['phone_verification', 'email_verification', 'password_reset'] })
  @IsEnum(['phone_verification', 'email_verification', 'password_reset'])
  purpose!: 'phone_verification' | 'email_verification' | 'password_reset';

  @ApiPropertyOptional({ description: 'Required for password_reset when unauthenticated' })
  @IsOptional()
  @IsEmail()
  email?: string;
}

export class VerifyOtpDto {
  @ApiProperty({ enum: ['phone_verification', 'email_verification', 'password_reset', 'mfa_challenge'] })
  @IsEnum(['phone_verification', 'email_verification', 'password_reset', 'mfa_challenge'])
  purpose!: 'phone_verification' | 'email_verification' | 'password_reset' | 'mfa_challenge';

  @ApiProperty({ example: '482913', description: 'Six-digit code' })
  @IsString()
  @Length(6, 6, { message: 'The verification code is six digits' })
  code!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;
}

export class ResetPasswordDto {
  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiProperty({ example: '482913' })
  @IsString()
  @Length(6, 6)
  code!: string;

  @ApiProperty()
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  newPassword!: string;
}

export class EnableMfaDto {
  @ApiProperty({ example: '482913', description: 'Code from the authenticator app' })
  @IsString()
  @Length(6, 6)
  code!: string;
}

export class VerifyMfaDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  mfaToken!: string;

  @ApiProperty({ example: '482913' })
  @IsString()
  @Length(6, 6)
  code!: string;
}

export class RegisterBiometricDto {
  @ApiProperty({ description: 'Device fingerprint the biometric key is bound to' })
  @IsString()
  @IsNotEmpty()
  deviceFingerprint!: string;

  @ApiProperty({ description: 'Public key produced by the platform keystore' })
  @IsString()
  @IsNotEmpty()
  publicKey!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  trusted?: boolean;
}

// --- responses -------------------------------------------------------------

export class TokenResponseDto {
  @ApiProperty() accessToken!: string;
  @ApiProperty() refreshToken!: string;
  @ApiProperty({ example: 900, description: 'Access token lifetime, seconds' }) expiresIn!: number;
  @ApiProperty({ example: 'Bearer' }) tokenType!: string;
}

export class MfaChallengeDto {
  @ApiProperty({ example: true }) mfaRequired!: boolean;
  @ApiProperty({ description: 'Short-lived token to present with the MFA code' })
  mfaToken!: string;
}

export class ProfileSummaryDto {
  @ApiProperty() userId!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: ['en', 'fr'] }) locale!: string;
  @ApiProperty({ type: [String] }) roles!: string[];
  @ApiProperty({ type: [String] }) permissions!: string[];
  @ApiPropertyOptional() lawyerId?: string;
  @ApiPropertyOptional({ enum: ['pending', 'verified', 'rejected'] }) verificationStatus?: string;
  @ApiProperty() mfaEnabled!: boolean;
  @ApiProperty() emailVerified!: boolean;
  @ApiProperty() phoneVerified!: boolean;
}
