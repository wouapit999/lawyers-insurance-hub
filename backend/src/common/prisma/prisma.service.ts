import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Database access.
 *
 * Two responsibilities beyond a plain PrismaClient:
 *
 *  1. **Tenant scoping.** `forTenant()` runs work inside a transaction that
 *     has `app.current_tenant` set, which is what the row-level security
 *     policies in 020_post_migrate.sql read. Application-level filtering is
 *     the first line of defence; RLS is the one that still holds if a query
 *     is built wrong.
 *
 *  2. **BigInt serialisation.** Money is bigint, and `JSON.stringify` throws
 *     on bigint. Rather than sprinkle `.toString()` through every controller,
 *     the serialiser is registered once at the edge (see main.ts).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Run `fn` with the tenant GUC set, inside a transaction.
   *
   * The setting is transaction-scoped (`set_config(..., true)`), so it cannot
   * leak to the next borrower of the pooled connection — a leak here would
   * mean one tenant reading another's rows, so the local flag is not
   * optional.
   */
  async forTenant<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}::text, true)`;
      return fn(tx);
    });
  }

  /**
   * Write a domain event to the outbox in the SAME transaction as the state
   * change that produced it.
   *
   * This is the transactional outbox pattern, and it is why the modules can
   * be split into services later without losing events: the event and the
   * data it describes commit together or not at all. A relay publishes to
   * RabbitMQ afterwards and marks the row published.
   */
  async emitEvent(
    tx: Prisma.TransactionClient,
    event: {
      tenantId: string;
      eventType: string;
      aggregateType: string;
      aggregateId: string;
      payload: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await tx.outboxEvent.create({ data: event });
  }
}
