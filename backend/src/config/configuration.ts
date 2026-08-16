import { Type, plainToInstance } from 'class-transformer';
import {
  IsEnum, IsInt, IsOptional, IsString, MinLength, validateSync,
} from 'class-validator';

/**
 * Environment validation.
 *
 * The application refuses to boot on a bad or missing secret rather than
 * starting and failing later on the first login or the first payment. A
 * container that will not start is a deploy that rolls back automatically;
 * one that starts and mis-signs tokens is an incident.
 */

export enum NodeEnv {
  development = 'development',
  test = 'test',
  staging = 'staging',
  production = 'production',
}

export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.development;

  // Every hosting platform — Vercel, Render, Kubernetes — supplies PORT as a
  // STRING in the environment. enableImplicitConversion alone did not coerce
  // it, so the app refused to boot with 'PORT must be an integer number'.
  // An explicit @Type is the reliable form.
  @Type(() => Number)
  @IsInt()
  PORT = 3000;

  @IsString()
  API_PREFIX = 'v1';

  @IsString()
  DATABASE_URL!: string;

  @IsOptional()
  @IsString()
  REDIS_URL?: string;

  // 32 characters is the floor for an HS256 signing key that is not trivially
  // brute-forceable. class-validator enforces it at boot.
  @IsString()
  @MinLength(32, { message: 'JWT_ACCESS_SECRET must be at least 32 characters' })
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @MinLength(32, { message: 'JWT_REFRESH_SECRET must be at least 32 characters' })
  JWT_REFRESH_SECRET!: string;

  @IsString()
  JWT_ACCESS_TTL = '15m';

  @IsString()
  JWT_REFRESH_TTL = '30d';

  /** Base64 32-byte key for column-level PII encryption. */
  @IsOptional()
  @IsString()
  PII_ENCRYPTION_KEY?: string;

  @IsEnum(['en', 'fr'])
  DEFAULT_LOCALE: 'en' | 'fr' = 'fr';

  // --- deployment target ----------------------------------------------------
  // The platform the API is running on. Affects defaults and warnings only —
  // no business logic branches on it. Switching to Azure later means changing
  // this and the driver values below, not any application code.
  @IsEnum(['local', 'render', 'azure'])
  DEPLOY_TARGET: 'local' | 'render' | 'azure' = 'local';

  /**
   * Where documents live.
   *   local       — filesystem; development only, EPHEMERAL on any container host
   *   supabase    — Supabase Storage, the free-tier target
   *   azure_blob  — Azure Blob Storage, the production target
   */
  @IsEnum(['local', 'supabase', 'azure_blob'])
  STORAGE_DRIVER: 'local' | 'supabase' | 'azure_blob' = 'local';

  @IsOptional() @IsString() SUPABASE_URL?: string;
  @IsOptional() @IsString() SUPABASE_SERVICE_KEY?: string;
  @IsOptional() @IsString() SUPABASE_STORAGE_BUCKET?: string;

  /** Public base URL of this API — used to build local signed download links. */
  @IsOptional() @IsString() PUBLIC_API_URL?: string;

  /** Error tracking. `none` is valid; it simply disables reporting. */
  @IsEnum(['none', 'sentry', 'appinsights'])
  TELEMETRY_DRIVER: 'none' | 'sentry' | 'appinsights' = 'none';

  // --- payment providers (optional in dev; the adapters fall back to a
  // sandbox simulator when unset, see payments/providers) ------------------
  @IsOptional() @IsString() ORANGE_MONEY_BASE_URL?: string;
  @IsOptional() @IsString() ORANGE_MONEY_CLIENT_ID?: string;
  @IsOptional() @IsString() ORANGE_MONEY_CLIENT_SECRET?: string;
  @IsOptional() @IsString() ORANGE_MONEY_MERCHANT_KEY?: string;
  @IsOptional() @IsString() ORANGE_MONEY_WEBHOOK_SECRET?: string;

  @IsOptional() @IsString() MTN_MOMO_BASE_URL?: string;
  @IsOptional() @IsString() MTN_MOMO_SUBSCRIPTION_KEY?: string;
  @IsOptional() @IsString() MTN_MOMO_API_USER?: string;
  @IsOptional() @IsString() MTN_MOMO_API_KEY?: string;
  @IsOptional() @IsString() MTN_MOMO_TARGET_ENVIRONMENT?: string;
  @IsOptional() @IsString() MTN_MOMO_WEBHOOK_SECRET?: string;

  @IsOptional() @IsString() CINETPAY_BASE_URL?: string;
  @IsOptional() @IsString() CINETPAY_API_KEY?: string;
  @IsOptional() @IsString() CINETPAY_SITE_ID?: string;
  @IsOptional() @IsString() CINETPAY_WEBHOOK_SECRET?: string;

  @IsOptional() @IsString() PAYMENT_CALLBACK_BASE_URL?: string;
  @IsOptional() @IsString() PAYMENT_RETURN_URL?: string;

  @IsOptional() @IsString() LOCAL_STORAGE_PATH?: string;
  @IsOptional() @IsString() AZURE_STORAGE_CONNECTION_STRING?: string;
  @IsOptional() @IsString() AZURE_STORAGE_ACCOUNT?: string;
  @IsOptional() @IsString() AZURE_STORAGE_CONTAINER?: string;
}

export function validateEnvironment(raw: Record<string, unknown>): EnvironmentVariables {
  const config = plainToInstance(EnvironmentVariables, raw, {
    enableImplicitConversion: true,
    exposeDefaultValues: true,
  });

  const errors = validateSync(config, { skipMissingProperties: false });
  if (errors.length > 0) {
    const detail = errors
      .map((e) => `  - ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }

  if (config.NODE_ENV === NodeEnv.production && !config.PII_ENCRYPTION_KEY) {
    throw new Error(
      'PII_ENCRYPTION_KEY is required in production — national ID and passport ' +
        'numbers must not be stored in plaintext.',
    );
  }

  // Fail at boot rather than at the first upload. A driver missing its
  // credentials is a deploy that should not have started; discovering it when
  // a lawyer tries to attach a photograph to a claim is far worse.
  if (config.STORAGE_DRIVER === 'supabase') {
    if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_KEY) {
      throw new Error(
        'STORAGE_DRIVER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_KEY',
      );
    }
  }

  if (config.STORAGE_DRIVER === 'azure_blob') {
    if (!config.AZURE_STORAGE_CONNECTION_STRING && !config.AZURE_STORAGE_ACCOUNT) {
      throw new Error(
        'STORAGE_DRIVER=azure_blob requires AZURE_STORAGE_CONNECTION_STRING ' +
          'or AZURE_STORAGE_ACCOUNT (workload identity)',
      );
    }
  }

  return config;
}

/** The single tenant the MVP runs under. Multi-tenant activation is Phase 3. */
export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';
