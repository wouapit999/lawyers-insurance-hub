import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  tenantId: string;
  actorId?: string | null;
  /** Dotted verb: policy.approve, claim.reject, role.grant, payment.refund */
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  /** Required for administrative overrides — the guard enforces it. */
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * The audit log.
 *
 * Every state change on a policy, claim, payment or permission goes through
 * here. The table is append-only at the database level (a trigger rejects
 * UPDATE and DELETE), partitioned monthly, and retained seven years — this
 * is the evidence trail a CIMA inspector or a court would ask for, so it has
 * to be complete and it has to be tamper-evident.
 *
 * Writes participate in the caller's transaction when one is passed. That
 * matters: an audit row for a policy approval that rolled back would be a
 * record of something that never happened.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;

    try {
      await client.auditLog.create({
        data: {
          tenantId: entry.tenantId,
          actorId: entry.actorId ?? null,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId ?? null,
          before: this.sanitise(entry.before),
          after: this.sanitise(entry.after),
          reason: entry.reason ?? null,
          ip: entry.ip ?? null,
          userAgent: entry.userAgent ?? null,
        },
      });
    } catch (error) {
      // Never let an audit failure roll back the business operation when the
      // caller is not already in a transaction — but shout about it, because
      // a silent gap in the audit trail is a compliance finding.
      if (tx) throw error;
      this.logger.error(
        `AUDIT WRITE FAILED for ${entry.action} on ${entry.entityType}:${entry.entityId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Strip secrets before they reach the audit table.
   *
   * before/after snapshots are taken from entity rows, and some of those rows
   * carry password hashes, MFA secrets and encrypted PII. The audit log is
   * widely readable inside the company — it must not become the place where
   * those values are conveniently collected.
   */
  private sanitise(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined || value === null) return undefined;

    const REDACTED = '[redacted]';
    const SENSITIVE = new Set([
      'passwordHash', 'password', 'mfaSecret', 'refreshTokenHash', 'codeHash',
      'nationalIdNo', 'passportNo', 'biometricKey', 'pushToken',
    ]);

    const walk = (input: unknown): unknown => {
      if (input === null || typeof input !== 'object') {
        return typeof input === 'bigint' ? input.toString() : input;
      }
      if (Array.isArray(input)) return input.map(walk);
      if (input instanceof Date) return input.toISOString();

      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
        out[key] = SENSITIVE.has(key) ? REDACTED : walk(val);
      }
      return out;
    };

    return walk(value) as Prisma.InputJsonValue;
  }
}
