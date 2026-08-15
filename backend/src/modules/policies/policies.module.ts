import {
  BadRequestException, Body, Controller, Get, Module, Param, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { PolicyStatus } from '@prisma/client';
import { IsOptional, IsString, MaxLength } from 'class-validator';

import { CurrentUser, type AuthenticatedUser } from '../../common/auth/current-user';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { PoliciesService } from './policies.service';
import { RequirePermissions } from '../../common/auth/permissions.guard';

export class SubscribeDto {
  @ApiProperty({ description: 'Quotation to convert. Must be unexpired and unconverted.' })
  @IsString() quoteId!: string;

  @ApiProperty({ required: false, description: 'Agent credited with the sale, for commission' })
  @IsOptional() @IsString() agentId?: string;
}

export class TransitionDto {
  @ApiProperty({ required: false, description: 'Recorded on the audit trail; mandatory for cancellation' })
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

@ApiTags('policies')
@ApiBearerAuth('bearer')
@Controller('policies')
export class PoliciesController {
  constructor(private readonly policies: PoliciesService) {}

  @Get()
  @RequirePermissions('policies:read:own')
  @ApiOperation({ summary: 'List the signed-in lawyer’s policies' })
  @ApiQuery({ name: 'status', required: false })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: PolicyStatus,
  ) {
    if (!user.lawyerId) return [];
    return this.policies.findForLawyer(user.lawyerId, status);
  }

  @Get(':id')
  @RequirePermissions('policies:read:own')
  @ApiOperation({ summary: 'A policy with its billing schedule, timeline and claims' })
  async findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.policies.findOne(id, user);
  }

  @Post()
  @RequirePermissions('policies:create:own')
  @ApiOperation({
    summary: 'Subscribe from a quotation',
    description:
      'Creates the policy and its invoice, and submits the application. Cover ' +
      'begins only when the first installment settles — the policy is not active ' +
      'when this returns.',
  })
  async subscribe(@CurrentUser() user: AuthenticatedUser, @Body() dto: SubscribeDto) {
    if (!user.lawyerId) throw new BadRequestException('onboarding.no_lawyer_profile');
    return this.policies.subscribe(
      dto.quoteId,
      { ...user, lawyerId: user.lawyerId },
      dto.agentId,
    );
  }

  @Post(':id/renew')
  @RequirePermissions('policies:renew:own')
  @ApiOperation({
    summary: 'Renew a policy',
    description:
      'Creates a successor policy priced with the rating table in force today ' +
      'and marks the current one renewed. The expiring policy is never edited.',
  })
  async renew(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    if (!user.lawyerId) throw new BadRequestException('onboarding.no_lawyer_profile');
    return this.policies.renew(id, { ...user, lawyerId: user.lawyerId });
  }

  @Post(':id/cancel')
  @RequirePermissions('policies:cancel:own')
  @ApiOperation({ summary: 'Cancel a policy' })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: TransitionDto,
  ) {
    return this.policies.transition(id, 'cancel', user, { note: dto.note });
  }

  // --- underwriting ------------------------------------------------------

  @Post(':id/review')
  @RequirePermissions('policies:review:all')
  @ApiOperation({ summary: 'Take an application under review' })
  async review(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.policies.transition(id, 'start_review', user);
  }

  @Post(':id/approve')
  @RequirePermissions('policies:approve:all')
  @ApiOperation({ summary: 'Approve an application' })
  async approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: TransitionDto,
  ) {
    return this.policies.transition(id, 'approve', user, { note: dto.note });
  }

  @Post(':id/suspend')
  @RequirePermissions('policies:suspend:all')
  @ApiOperation({ summary: 'Suspend cover' })
  async suspend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: TransitionDto,
  ) {
    return this.policies.transition(id, 'suspend', user, { note: dto.note });
  }
}

@Module({
  imports: [OnboardingModule],
  controllers: [PoliciesController],
  providers: [PoliciesService],
  exports: [PoliciesService],
})
export class PoliciesModule {}
