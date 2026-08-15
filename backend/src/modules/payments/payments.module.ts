import {
  BadRequestException, Body, Controller, Get, Headers, HttpCode, HttpStatus, Module,
  Param, Post, Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { PaymentProviderCode } from '@prisma/client';
import type { Request } from 'express';
import { I18n, I18nContext } from 'nestjs-i18n';

import { CardProvider } from './providers/card.provider';
import { CurrentUser, type AuthenticatedUser } from '../../common/auth/current-user';
import { MtnMomoProvider } from './providers/mtn-momo.provider';
import { OrangeMoneyProvider } from './providers/orange-money.provider';
import { PayClaimDto, PayInstallmentDto, RefundDto } from './dto/payments.dto';
import { PaymentsService } from './payments.service';
import { PoliciesModule } from '../policies/policies.module';
import { Public, RequireMfa, RequirePermissions } from '../../common/auth/permissions.guard';

@ApiTags('payments')
@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @ApiBearerAuth('bearer')
  @Post('installments/:id/pay')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions('payments:create:own')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'A unique key per payment attempt (a UUID is ideal). Replaying a key returns ' +
      'the original payment instead of charging again — send the same key on retry.',
  })
  @ApiOperation({
    summary: 'Pay an installment',
    description:
      'Returns 202 with a nextAction telling the client what to do: confirm a USSD ' +
      'prompt for mobile money, or follow a redirect for cards. The payment is not ' +
      'settled when this returns; poll the payment or wait for the push notification.',
  })
  async pay(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') installmentId: string,
    @Body() dto: PayInstallmentDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @I18n() i18n: I18nContext,
  ) {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException('An Idempotency-Key header is required');
    }
    return this.payments.payInstallment(installmentId, dto, idempotencyKey.trim(), {
      userId: user.userId,
      tenantId: user.tenantId,
      lawyerId: user.lawyerId,
      locale: (i18n.lang as 'en' | 'fr') ?? 'fr',
    });
  }

  @ApiBearerAuth('bearer')
  @Get('payments/history')
  @RequirePermissions('payments:read:own')
  @ApiOperation({ summary: 'The signed-in lawyer’s payment history and receipts' })
  async history(@CurrentUser() user: AuthenticatedUser) {
    if (!user.lawyerId) return [];
    return this.payments.history(user.lawyerId);
  }

  // --- finance operations -------------------------------------------------

  @ApiBearerAuth('bearer')
  @Post('claims/:id/payout')
  @RequirePermissions('claims:pay:all')
  @RequireMfa()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({
    summary: 'Pay an approved claim',
    description: 'Requires a fresh two-factor challenge — this moves money out.',
  })
  async payout(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') claimId: string,
    @Body() dto: PayClaimDto,
    @Headers('idempotency-key') idempotencyKey: string,
  ) {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException('An Idempotency-Key header is required');
    }
    return this.payments.payClaim(
      claimId,
      { provider: dto.provider, msisdn: dto.msisdn, idempotencyKey: idempotencyKey.trim() },
      { userId: user.userId, tenantId: user.tenantId },
    );
  }

  @ApiBearerAuth('bearer')
  @Post('payments/:id/refund')
  @RequirePermissions('payments:refund:all')
  @RequireMfa()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({
    summary: 'Refund a settled payment, in whole or in part',
    description:
      'Creates a refund payment referencing the original. The original row is never ' +
      'modified — it remains the record of what was collected.',
  })
  async refund(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') paymentId: string,
    @Body() dto: RefundDto,
    @Headers('idempotency-key') idempotencyKey: string,
  ) {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException('An Idempotency-Key header is required');
    }
    return this.payments.refund(
      paymentId,
      dto.amountXaf ? BigInt(dto.amountXaf) : null,
      dto.reason,
      idempotencyKey.trim(),
      { userId: user.userId, tenantId: user.tenantId },
    );
  }

  // --- provider callbacks -------------------------------------------------

  @Public()
  @Post('payments/webhooks/:provider')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Provider callback endpoint',
    description:
      'Public by necessity — the gateways call it. Every callback is HMAC-verified ' +
      'and then independently confirmed against the provider before any money is ' +
      'recorded as settled. Always answers 200 so a provider does not disable the ' +
      'endpoint after retries it can never satisfy.',
  })
  async webhook(
    @Param('provider') provider: PaymentProviderCode,
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    return this.payments.handleWebhook(
      provider,
      req.headers as Record<string, string | undefined>,
      body,
    );
  }
}

@Module({
  imports: [PoliciesModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, OrangeMoneyProvider, MtnMomoProvider, CardProvider],
  exports: [PaymentsService],
})
export class PaymentsModule {}
