import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { CurrentUser, type AuthenticatedUser } from '../../common/auth/current-user';
import { Public } from '../../common/auth/permissions.guard';
import { AuthService } from './auth.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TokenService } from './token.service';
import {
  EnableMfaDto, LoginDto, MfaChallengeDto, ProfileSummaryDto, RefreshDto,
  RegisterDto, RequestOtpDto, ResetPasswordDto, TokenResponseDto, VerifyMfaDto,
  VerifyOtpDto,
} from './dto/auth.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  private context(req: Request) {
    return {
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string) ?? null,
    };
  }

  // =========================================================================

  @Public()
  // Registration is expensive (two Argon2 hashes and two OTP sends) and is a
  // natural target for automated abuse, so it is throttled well below the
  // global default.
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post('register')
  @ApiOperation({
    summary: 'Register a lawyer account',
    description:
      'Creates the account and opens a Bar Association verification. The account ' +
      'can browse products and request quotations immediately; subscribing to a ' +
      'policy is gated on verification.',
  })
  @ApiResponse({ status: 201, description: 'Account created; verification pending' })
  @ApiResponse({ status: 409, description: 'Email, phone or Bar number already registered' })
  async register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.auth.register(dto, this.context(req));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in',
    description:
      'Returns a token pair, or an MFA challenge when the account has two-factor ' +
      'authentication enabled. Five consecutive failures lock the account for ' +
      '15 minutes.',
  })
  @ApiResponse({ status: 200, type: TokenResponseDto })
  @ApiResponse({ status: 200, type: MfaChallengeDto, description: 'MFA required' })
  @ApiResponse({ status: 401, description: 'Invalid credentials, locked or suspended' })
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, this.context(req));
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete sign-in with a two-factor code' })
  @ApiResponse({ status: 200, type: TokenResponseDto })
  async verifyMfa(@Body() dto: VerifyMfaDto, @Req() req: Request) {
    return this.auth.completeMfaLogin(dto.mfaToken, dto.code, this.context(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new pair',
    description:
      'Refresh tokens rotate on every use. Presenting a token that has already ' +
      'been rotated revokes every session for that user — that pattern means the ' +
      'token was copied.',
  })
  @ApiResponse({ status: 200, type: TokenResponseDto })
  @ApiResponse({ status: 401, description: 'Expired, revoked or replayed token' })
  async refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.tokens.rotate(dto.refreshToken, this.context(req));
  }

  // =========================================================================

  @Public()
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @Post('otp/request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a one-time code' })
  @ApiBody({ type: RequestOtpDto })
  async requestOtp(@Body() dto: RequestOtpDto) {
    if (dto.purpose === 'password_reset') {
      if (!dto.email) return { sent: true }; // never confirm what we did not do
      return this.auth.requestPasswordReset(dto.email);
    }
    return { sent: true };
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('bearer')
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify an email or phone one-time code' })
  async verifyOtp(@CurrentUser() user: AuthenticatedUser, @Body() dto: VerifyOtpDto) {
    if (dto.purpose === 'password_reset' || dto.purpose === 'mfa_challenge') {
      return { verified: false, message: 'Use the dedicated endpoint for this purpose' };
    }
    return this.auth.verifyContact(user.userId, dto.purpose, dto.code);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @Post('password/reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reset a password with a one-time code',
    description: 'Signs out every other session on success.',
  })
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    return this.auth.resetPassword(dto, this.context(req));
  }

  // =========================================================================

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('bearer')
  @Post('mfa/enrol')
  @ApiOperation({
    summary: 'Begin two-factor enrolment',
    description:
      'Returns a secret and an otpauth:// URL to render as a QR code. Two-factor ' +
      'authentication is not active until the code is confirmed.',
  })
  async enrolMfa(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.beginMfaEnrolment(user.userId, user.email);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('bearer')
  @Post('mfa/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm and activate two-factor authentication' })
  async confirmMfa(@CurrentUser() user: AuthenticatedUser, @Body() dto: EnableMfaDto) {
    return this.auth.confirmMfaEnrolment(user.userId, dto);
  }

  // =========================================================================

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('bearer')
  @Get('me')
  @ApiOperation({ summary: 'The signed-in user, their roles and effective permissions' })
  @ApiResponse({ status: 200, type: ProfileSummaryDto })
  async me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.profile(user.userId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('bearer')
  @Get('sessions')
  @ApiOperation({ summary: 'Active sessions and the devices behind them' })
  async sessions(@CurrentUser() user: AuthenticatedUser) {
    const sessions = await this.prisma.session.findMany({
      where: { userId: user.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: {
        id: true, ip: true, userAgent: true, createdAt: true, expiresAt: true,
        device: { select: { label: true, platform: true, lastSeenAt: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return sessions.map((s) => ({ ...s, current: s.id === user.sessionId }));
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('bearer')
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke one session' })
  async revokeSession(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    // Scoped to the caller's own sessions: the id alone must not be enough to
    // sign out somebody else.
    const session = await this.prisma.session.findFirst({
      where: { id, userId: user.userId },
      select: { id: true },
    });
    if (session) await this.tokens.revokeSession(session.id);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('bearer')
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Sign out of the current session' })
  async logout(@CurrentUser() user: AuthenticatedUser) {
    await this.tokens.revokeSession(user.sessionId);
  }

  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth('bearer')
  @Post('logout/all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign out of every session on every device' })
  async logoutAll(@CurrentUser() user: AuthenticatedUser) {
    const revoked = await this.tokens.revokeAllForUser(user.userId);
    return { revoked };
  }
}
