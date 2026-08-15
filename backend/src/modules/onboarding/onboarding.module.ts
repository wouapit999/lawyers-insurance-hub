import {
  Body, Controller, Delete, ForbiddenException, Get, HttpCode, HttpStatus, Module,
  Param, Patch, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { CurrentUser, type AuthenticatedUser } from '../../common/auth/current-user';
import { RequirePermissions } from '../../common/auth/permissions.guard';
import { OnboardingService } from './onboarding.service';
import {
  CreateBeneficiaryDto, CreateVehicleDto, UpdateProfileDto, VerificationDecisionDto,
} from './dto/onboarding.dto';

/**
 * Resolve the lawyer whose records the caller is acting on.
 *
 * A lawyer always acts on their own profile — the id comes from the token,
 * never from the URL, so a crafted request cannot reach another member's
 * family or vehicles. Staff with `members:read:all` may pass an explicit id.
 */
function resolveLawyerId(user: AuthenticatedUser, requested?: string): string {
  if (!requested || requested === 'me') {
    if (!user.lawyerId) {
      throw new ForbiddenException('This account is not linked to a lawyer profile');
    }
    return user.lawyerId;
  }
  if (requested !== user.lawyerId && !user.permissions.includes('members:read:all')) {
    throw new ForbiddenException('You may only access your own records');
  }
  return requested;
}

@ApiTags('onboarding')
@ApiBearerAuth('bearer')
@Controller('members')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get('me')
  @RequirePermissions('members:read:own')
  @ApiOperation({ summary: 'The signed-in lawyer’s profile (identity numbers masked)' })
  async myProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.onboarding.getProfile(resolveLawyerId(user));
  }

  @Patch('me')
  @RequirePermissions('members:update:own')
  @ApiOperation({ summary: 'Update the signed-in lawyer’s profile' })
  async updateProfile(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto) {
    return this.onboarding.updateProfile(resolveLawyerId(user), dto, user.userId);
  }

  // --- family ------------------------------------------------------------

  @Get('me/beneficiaries')
  @RequirePermissions('beneficiaries:manage:own')
  @ApiOperation({ summary: 'List beneficiaries' })
  async beneficiaries(@CurrentUser() user: AuthenticatedUser) {
    return this.onboarding.listBeneficiaries(resolveLawyerId(user));
  }

  @Post('me/beneficiaries')
  @RequirePermissions('beneficiaries:manage:own')
  @ApiOperation({
    summary: 'Add a beneficiary',
    description: 'Issues a card number usable at network providers.',
  })
  async addBeneficiary(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBeneficiaryDto,
  ) {
    return this.onboarding.addBeneficiary(resolveLawyerId(user), dto, user.userId);
  }

  @Delete('me/beneficiaries/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('beneficiaries:manage:own')
  @ApiOperation({ summary: 'Remove a beneficiary not covered by an active policy' })
  async removeBeneficiary(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    await this.onboarding.removeBeneficiary(resolveLawyerId(user), id, user.userId);
  }

  // --- vehicles ----------------------------------------------------------

  @Get('me/vehicles')
  @RequirePermissions('vehicles:manage:own')
  @ApiOperation({ summary: 'List registered vehicles' })
  async vehicles(@CurrentUser() user: AuthenticatedUser) {
    return this.onboarding.listVehicles(resolveLawyerId(user));
  }

  @Post('me/vehicles')
  @RequirePermissions('vehicles:manage:own')
  @ApiOperation({ summary: 'Register a vehicle' })
  async addVehicle(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateVehicleDto) {
    return this.onboarding.addVehicle(resolveLawyerId(user), dto, user.userId);
  }
}

/**
 * The Bar Association's portal.
 *
 * Deliberately narrow. The Bar verifies membership and reads aggregates; it
 * has no route here to any individual policy, claim or payment, and the
 * bar_admin role holds no permission that would grant one.
 */
@ApiTags('onboarding')
@ApiBearerAuth('bearer')
@Controller('bar')
export class BarPortalController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get('verifications')
  @RequirePermissions('bar:verify:all')
  @ApiOperation({
    summary: 'Pending membership verifications',
    description: 'Ordered by SLA deadline. Verifications escalate 24 hours after submission.',
  })
  @ApiQuery({ name: 'status', required: false, enum: ['pending', 'verified', 'rejected'] })
  async queue(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: 'pending' | 'verified' | 'rejected',
  ) {
    return this.onboarding.verificationQueue(user.tenantId, status ?? 'pending');
  }

  @Post('verifications/:id/decision')
  @RequirePermissions('bar:verify:all')
  @ApiOperation({
    summary: 'Approve or reject a verification',
    description: 'A reason is mandatory on rejection and is shown to the applicant.',
  })
  async decide(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: VerificationDecisionDto,
  ) {
    return this.onboarding.decideVerification(id, dto, {
      userId: user.userId,
      tenantId: user.tenantId,
    });
  }
}

@Module({
  controllers: [OnboardingController, BarPortalController],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
