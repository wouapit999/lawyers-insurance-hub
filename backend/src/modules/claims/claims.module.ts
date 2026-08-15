import { Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { ClaimsService } from './claims.service';
import { CurrentUser, type AuthenticatedUser } from '../../common/auth/current-user';
import { FileClaimDto, TransitionClaimDto } from './dto/claims.dto';
import { RequirePermissions } from '../../common/auth/permissions.guard';

@ApiTags('claims')
@ApiBearerAuth('bearer')
@Controller('claims')
export class ClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  @Post()
  @RequirePermissions('claims:create:own')
  @ApiOperation({
    summary: 'File a claim',
    description:
      'The policy must be active and the incident must fall inside its cover ' +
      'period. A fraud score is attached at filing to sort the officer queue; ' +
      'it never affects the outcome.',
  })
  async file(@CurrentUser() user: AuthenticatedUser, @Body() dto: FileClaimDto) {
    return this.claims.file(dto, user);
  }

  @Get()
  @RequirePermissions('claims:read:own')
  @ApiOperation({ summary: 'The signed-in lawyer’s claims' })
  async mine(@CurrentUser() user: AuthenticatedUser) {
    if (!user.lawyerId) return [];
    return this.claims.listForLawyer(user.lawyerId);
  }

  @Get('queue')
  @RequirePermissions('claims:read:all')
  @ApiOperation({
    summary: 'Officer work queue',
    description: 'Open claims ordered by SLA deadline, each tagged on-track, due-soon or breached.',
  })
  @ApiQuery({ name: 'mine', required: false, type: Boolean })
  async queue(@CurrentUser() user: AuthenticatedUser, @Query('mine') mine?: string) {
    return this.claims.queue(user.tenantId, mine === 'true' ? user.userId : undefined);
  }

  @Get(':id')
  @RequirePermissions('claims:read:own')
  @ApiOperation({
    summary: 'A claim with its evidence, timeline and available next steps',
    description:
      'availableTransitions lists only the moves this caller may actually make, ' +
      'so a client can render buttons directly from it.',
  })
  async findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.claims.findOne(id, user);
  }

  // --- workflow ----------------------------------------------------------

  @Post(':id/investigate')
  @RequirePermissions('claims:investigate:all')
  @ApiOperation({ summary: 'Begin investigation (72-hour SLA)' })
  async investigate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: TransitionClaimDto,
  ) {
    return this.claims.transition(id, 'start_investigation', dto, user);
  }

  @Post(':id/assess')
  @RequirePermissions('claims:assess:all')
  @ApiOperation({ summary: 'Move to assessment (96-hour SLA)' })
  async assess(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: TransitionClaimDto,
  ) {
    return this.claims.transition(id, 'start_assessment', dto, user);
  }

  @Post(':id/approve')
  @RequirePermissions('claims:approve:all')
  @ApiOperation({
    summary: 'Approve an indemnity',
    description: 'Requires approvedXaf, which may not exceed the amount claimed.',
  })
  async approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: TransitionClaimDto,
  ) {
    return this.claims.transition(id, 'approve', dto, user);
  }

  @Post(':id/reject')
  @RequirePermissions('claims:approve:all')
  @ApiOperation({ summary: 'Reject a claim, with a mandatory reason' })
  async reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: TransitionClaimDto,
  ) {
    return this.claims.transition(id, 'reject', dto, user);
  }

  @Post(':id/close')
  @RequirePermissions('claims:close:all')
  @ApiOperation({ summary: 'Close the file' })
  async close(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: TransitionClaimDto,
  ) {
    return this.claims.transition(id, 'close', dto, user);
  }
}

@Module({
  controllers: [ClaimsController],
  providers: [ClaimsService],
  exports: [ClaimsService],
})
export class ClaimsModule {}
