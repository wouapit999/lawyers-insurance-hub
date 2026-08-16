/**
 * Vercel serverless entry point for the NestJS API.
 *
 * Why Vercel rather than the Render free tier: Render's free web service
 * sleeps after 15 minutes, and a payment webhook arriving at a sleeping
 * instance can be lost. Serverless functions do not sleep in that sense —
 * they cold start in a second or two, well inside what MTN and Orange
 * tolerate. For a platform whose worst failure mode is a lost settlement
 * callback, that is the more important property.
 *
 * The trade-offs, stated plainly:
 *   * Cold start on the first request after idle (~1-2s with Prisma).
 *   * Function duration is capped, so nothing here may run long. The
 *     reconciliation sweep therefore belongs in a scheduled job, not a
 *     request handler.
 *   * No in-process state survives between invocations. The application
 *     already assumes this — sessions and OTP codes live in Postgres, not
 *     in memory — so nothing needed changing.
 *
 * The Nest application is cached across invocations on a warm instance, so
 * the framework boot cost is paid once per container rather than per request.
 */
import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Express } from 'express';
import express from 'express';
import { ExpressAdapter } from '@nestjs/platform-express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';

import { AppModule } from '../src/app.module';
import { ProblemDetailsFilter } from '../src/common/filters/problem-details.filter';

// Money is bigint throughout the domain and JSON.stringify throws on it.
// Registered here for the same reason as in main.ts — a premium crosses the
// wire as the string "285000", never a float.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function toJSON(
  this: bigint,
) {
  return this.toString();
};

let cached: Express | null = null;

async function bootstrap(): Promise<Express> {
  if (cached) return cached;

  const expressApp = express();
  const app = await NestFactory.create(
    AppModule,
    new ExpressAdapter(expressApp),
    { logger: ['error', 'warn', 'log'] },
  );

  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const id = (req.headers['x-request-id'] as string) ?? randomUUID();
    req.headers['x-request-id'] = id;
    res.setHeader('X-Request-Id', id);
    next();
  });

  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

  app.enableCors({
    origin: [/\.vercel\.app$/, /\.lih\.cm$/, 'http://localhost:3001'],
    credentials: true,
    allowedHeaders: [
      'Content-Type', 'Authorization', 'Accept-Language',
      'X-Request-Id', 'Idempotency-Key',
    ],
    exposedHeaders: ['X-Request-Id'],
  });

  app.setGlobalPrefix(process.env.API_PREFIX ?? 'v1', {
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
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      validationError: { target: false, value: false },
    }),
  );

  app.useGlobalFilters(new ProblemDetailsFilter());

  await app.init();

  cached = expressApp;
  return expressApp;
}

export default async function handler(req: express.Request, res: express.Response) {
  const app = await bootstrap();
  return app(req, res);
}
