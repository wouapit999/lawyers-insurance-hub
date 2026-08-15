import {
  BadRequestException, Body, Controller, Get, Injectable, Module, Param, Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsObject, IsOptional, IsString } from 'class-validator';
import { I18n, I18nContext } from 'nestjs-i18n';

import { rate, splitEvenly, type RatingTableDefinition } from '@lih/domain';

import { CurrentUser, type AuthenticatedUser } from '../../common/auth/current-user';
import { Public, RequirePermissions } from '../../common/auth/permissions.guard';
import { PrismaService } from '../../common/prisma/prisma.service';

export class CreateQuoteDto {
  @ApiProperty({ example: 'PLI-SILVER', description: 'Plan code from the catalogue' })
  @IsString() planCode!: string;

  @ApiProperty({
    type: 'object', additionalProperties: true,
    example: { practice_areas: 'corporate', years_admitted: 8, firm_size: 4, prior_claims: false },
    description: 'Rating inputs. The required fields depend on the product.',
  })
  @IsObject() factors!: Record<string, string | number | boolean>;

  @ApiPropertyOptional({ enum: [1, 2, 4, 12], default: 1 })
  @IsOptional() @IsInt() installments?: number;
}

/**
 * Product catalogue and quotation.
 *
 * Pricing never happens anywhere but here, and it always goes through the
 * versioned rating table that is in force on the day of the quote. The quote
 * stores which table version priced it, so converting it into a policy later
 * cannot silently pick up a repricing that happened in between.
 */
@Injectable()
export class CatalogueService {
  /** How long a quoted price is honoured. */
  private static readonly QUOTE_VALIDITY_HOURS = 24;

  constructor(private readonly prisma: PrismaService) {}

  /** Catalogue in the caller's language — no client-side translation table. */
  async listProducts(locale: 'en' | 'fr') {
    const products = await this.prisma.product.findMany({
      where: { isActive: true },
      include: { plans: { where: { isActive: true }, orderBy: { sortOrder: 'asc' } } },
      orderBy: { sortOrder: 'asc' },
    });

    return products.map((p) => ({
      code: p.code,
      name: locale === 'fr' ? p.nameFr : p.nameEn,
      description: locale === 'fr' ? p.descriptionFr : p.descriptionEn,
      plans: p.plans.map((plan) => ({
        code: plan.code,
        name: locale === 'fr' ? plan.nameFr : plan.nameEn,
        basePremiumXaf: plan.basePremiumXaf,
        installmentOptions: plan.installmentOptions,
        coverage: plan.coverage,
      })),
    }));
  }

  /**
   * Price a plan for an applicant.
   *
   * Returns the premium, the installment schedule, and the full factor-by-
   * factor breakdown that produced it. The breakdown is persisted, not
   * recomputed on demand: a lawyer disputing a renewal premium two years from
   * now gets the arithmetic exactly as it was applied.
   */
  async createQuote(
    lawyerId: string,
    tenantId: string,
    dto: CreateQuoteDto,
    locale: 'en' | 'fr',
  ) {
    const plan = await this.prisma.plan.findFirst({
      where: { code: dto.planCode, isActive: true },
      include: { product: true },
    });
    if (!plan) throw new BadRequestException('policy.plan_unavailable');

    const installments = dto.installments ?? 1;
    if (!plan.installmentOptions.includes(installments)) {
      throw new BadRequestException(
        `This plan supports ${plan.installmentOptions.join(', ')} installments`,
      );
    }

    // The table in force today — the most recent one whose effective date has
    // arrived. A table dated in the future is staged, not live.
    const ratingTable = await this.prisma.ratingTable.findFirst({
      where: { planId: plan.id, effectiveFrom: { lte: new Date() } },
      orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
    });
    if (!ratingTable) throw new BadRequestException('policy.no_rating_table');

    const { premiumXaf, breakdown } = rate(
      plan.basePremiumXaf,
      ratingTable.factors as unknown as RatingTableDefinition,
      dto.factors,
    );

    const schedule = splitEvenly(premiumXaf, installments);

    const quote = await this.prisma.quote.create({
      data: {
        tenantId,
        lawyerId,
        planId: plan.id,
        ratingTableId: ratingTable.id,
        factors: dto.factors,
        premiumXaf,
        installments,
        installmentXaf: schedule[0]!,
        breakdown: breakdown as unknown as object,
        validUntil: new Date(Date.now() + CatalogueService.QUOTE_VALIDITY_HOURS * 3_600_000),
      },
    });

    return {
      id: quote.id,
      planCode: plan.code,
      productCode: plan.product.code,
      planName: locale === 'fr' ? plan.nameFr : plan.nameEn,
      premiumXaf: quote.premiumXaf,
      installments,
      schedule,
      breakdown,
      validUntil: quote.validUntil,
    };
  }

  async getQuote(quoteId: string, lawyerId: string) {
    const quote = await this.prisma.quote.findFirstOrThrow({
      where: { id: quoteId, lawyerId },
      include: { plan: { include: { product: true } } },
    });
    return quote;
  }
}

@ApiTags('catalogue')
@Controller()
export class CatalogueController {
  constructor(private readonly catalogue: CatalogueService) {}

  @Public()
  @Get('products')
  @ApiOperation({
    summary: 'Browse the product catalogue',
    description:
      'Public so a prospective member can compare cover before registering. ' +
      'Names and descriptions are returned in the language of Accept-Language.',
  })
  async products(@I18n() i18n: I18nContext) {
    return this.catalogue.listProducts((i18n.lang as 'en' | 'fr') ?? 'fr');
  }

  @ApiBearerAuth('bearer')
  @Post('quotes')
  @RequirePermissions('quotes:create:own')
  @ApiOperation({
    summary: 'Request a quotation',
    description:
      'Available before Bar verification completes — only subscribing is gated. ' +
      'The price is held for 24 hours.',
  })
  async quote(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateQuoteDto,
    @I18n() i18n: I18nContext,
  ) {
    if (!user.lawyerId) throw new BadRequestException('This account has no lawyer profile');
    return this.catalogue.createQuote(
      user.lawyerId,
      user.tenantId,
      dto,
      (i18n.lang as 'en' | 'fr') ?? 'fr',
    );
  }

  @ApiBearerAuth('bearer')
  @Get('quotes/:id')
  @RequirePermissions('quotes:read:own')
  @ApiOperation({ summary: 'Retrieve a quotation and its price breakdown' })
  async getQuote(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.catalogue.getQuote(id, user.lawyerId!);
  }
}

@Module({
  controllers: [CatalogueController],
  providers: [CatalogueService],
  exports: [CatalogueService],
})
export class CatalogueModule {}
