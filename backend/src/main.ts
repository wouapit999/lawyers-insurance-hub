import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { AppModule } from './app.module';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter';

/**
 * BigInt JSON serialisation.
 *
 * Money is bigint throughout the domain, and JSON.stringify throws on bigint
 * rather than guessing. Registering the serialiser once here means a premium
 * crosses the wire as the string "285000" — a string, not a number, because
 * a JavaScript client parsing 285000 as a float is exactly the precision loss
 * the bigint was chosen to avoid.
 */
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function toJSON(this: bigint) {
  return this.toString();
};

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  const prefix = config.get<string>('API_PREFIX', 'v1');
  const port = config.get<number>('PORT', 3000);
  const isProd = config.get<string>('NODE_ENV') === 'production';

  // --- correlation id -------------------------------------------------------
  // Assigned before anything else so it is available to every log line and to
  // the error filter. Echoed back so a user can quote it to support.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const id = (req.headers['x-request-id'] as string) ?? randomUUID();
    req.headers['x-request-id'] = id;
    res.setHeader('X-Request-Id', id);
    next();
  });

  app.use(
    helmet({
      contentSecurityPolicy: isProd ? undefined : false, // Swagger UI needs inline styles in dev
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.enableCors({
    origin: isProd
      ? [/\.lih\.cm$/, /\.bouquet-innovation\.net$/]
      : true,
    credentials: true,
    allowedHeaders: [
      'Content-Type', 'Authorization', 'Accept-Language',
      'X-Request-Id', 'Idempotency-Key',
    ],
    exposedHeaders: ['X-Request-Id'],
  });

  app.setGlobalPrefix(prefix, {
    // Health and metrics stay unprefixed for the Kubernetes probes.
    exclude: ['health', 'health/ready', 'health/live'],
  });
  // NOTE: URI versioning is deliberately NOT enabled alongside this prefix.
  // setGlobalPrefix('v1') already supplies the version segment; adding
  // enableVersioning({ type: URI }) makes Nest insert a SECOND one, and every
  // route lands at /v1/v1/... while the startup log still prints /v1/...,
  // which makes the mismatch invisible until a request 404s.
  // When a genuine v2 is needed, introduce versioning and drop the prefix.

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,           // strip properties with no DTO decorator
      forbidNonWhitelisted: true, // and reject the request that sent them
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      validationError: { target: false, value: false },
    }),
  );

  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableShutdownHooks();

  // --- OpenAPI --------------------------------------------------------------
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Lawyers Insurance Hub API')
    .setDescription(
      [
        'Insurance platform for members of the Cameroon Bar Association.',
        '',
        '**Language** — send `Accept-Language: en` or `fr`. Every message,',
        'validation error and generated document honours it.',
        '',
        '**Money** — all amounts are whole XAF francs, serialised as strings',
        '(`"285000"`). XAF has no minor unit; there are no decimals anywhere.',
        '',
        '**Idempotency** — every payment-mutating endpoint requires an',
        '`Idempotency-Key` header. Replaying a key returns the original result',
        'instead of charging twice.',
        '',
        '**Errors** — RFC 9457 `application/problem+json`, localised, with a',
        '`requestId` that matches the server logs.',
      ].join('\n'),
    )
    .setVersion('1.0.0')
    .setContact('Bouquet Innovation', 'https://bouquet-innovation.net', 'rwouapit@bouquet-innovation.net')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Access token from POST /v1/auth/login' },
      'bearer',
    )
    .addGlobalParameters({
      name: 'Accept-Language',
      in: 'header',
      required: false,
      schema: { type: 'string', enum: ['en', 'fr'], default: 'fr' },
    })
    .addTag('auth', 'Registration, sign-in, OTP, MFA, sessions')
    .addTag('onboarding', 'Lawyer profiles and Bar Association verification')
    .addTag('members', 'Beneficiaries, vehicles, law firms')
    .addTag('catalogue', 'Products, plans and quotations')
    .addTag('policies', 'Subscription, renewal and certificates')
    .addTag('claims', 'Filing, evidence and the claims workflow')
    .addTag('payments', 'Mobile money, cards, refunds and reconciliation')
    .addTag('admin', 'Users, roles, products, audit')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup(`${prefix}/docs`, app, document, {
    swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha' },
    customSiteTitle: 'LIH API — Documentation',
    jsonDocumentUrl: `${prefix}/docs/openapi.json`,
  });

  await app.listen(port, '0.0.0.0');

  logger.log(`LIH API listening on :${port} (${config.get('NODE_ENV')})`);
  logger.log(`OpenAPI documentation at /${prefix}/docs`);
}

void bootstrap();
