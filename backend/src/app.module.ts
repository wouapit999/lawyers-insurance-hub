import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import {
  AcceptLanguageResolver, HeaderResolver, I18nModule, QueryResolver,
} from 'nestjs-i18n';
import { join } from 'node:path';

import { AuthModule } from './modules/auth/auth.module';
import { CatalogueModule } from './modules/catalogue/catalogue.module';
import { ClaimsModule } from './modules/claims/claims.module';
import { CommonModule } from './common/common.module';
import { HealthModule } from './modules/health/health.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PoliciesModule } from './modules/policies/policies.module';
import { validateEnvironment } from './config/configuration';

/**
 * Application root.
 *
 * Each feature module below is a bounded context that maps 1:1 to one of the
 * approved microservices. They share a process today and a database schema,
 * but not each other's tables: a module reaches another module through its
 * exported service or through a domain event, never through a foreign
 * repository. That discipline is what makes extraction later a deployment
 * change rather than a rewrite.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
      envFilePath: ['.env.local', '.env', '../../.env'],
    }),

    // Bilingual by construction: the locale is resolved per request from the
    // header the mobile and web clients send, and every service can translate
    // without threading a locale argument through its signatures.
    I18nModule.forRoot({
      fallbackLanguage: process.env.DEFAULT_LOCALE ?? 'fr',
      fallbacks: { 'en-*': 'en', 'fr-*': 'fr' },
      loaderOptions: {
        path: join(__dirname, 'i18n'),
        watch: process.env.NODE_ENV !== 'production',
      },
      resolvers: [
        { use: QueryResolver, options: ['lang'] },
        new HeaderResolver(['x-lang']),
        AcceptLanguageResolver,
      ],
      typesOutputPath: undefined,
    }),

    // Baseline abuse protection. Auth routes tighten this considerably with
    // their own @Throttle decorators.
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 1_000, limit: 10 },
      { name: 'medium', ttl: 60_000, limit: 120 },
    ]),

    CommonModule,
    HealthModule,
    AuthModule,
    OnboardingModule,
    CatalogueModule,
    PoliciesModule,
    ClaimsModule,
    PaymentsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
