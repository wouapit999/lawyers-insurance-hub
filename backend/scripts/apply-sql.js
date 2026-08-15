#!/usr/bin/env node
/**
 * Applies the raw SQL that Prisma's schema language cannot express.
 *
 * Order matters and is enforced by the caller:
 *   010_pre_migrate.sql   extensions + uuid_generate_v7()   (before migrate)
 *   prisma migrate deploy                                    (run separately)
 *   020_post_migrate.sql  RLS, partitions, partial indexes   (after migrate)
 *
 * Usage:
 *   node scripts/apply-sql.js pre
 *   node scripts/apply-sql.js post
 *
 * Both files are idempotent, so this runs as a pre-deploy job on every
 * release rather than once by hand.
 *
 * Why the `pg` client rather than Prisma's $executeRawUnsafe: Prisma sends
 * raw SQL through the extended query protocol, which permits exactly one
 * statement per message. These scripts are multi-statement and contain
 * PL/pgSQL DO blocks whose bodies are full of semicolons, so they can neither
 * be sent as one prepared statement nor split on ';' without corrupting the
 * function bodies. node-postgres' simple query protocol takes the whole
 * script as written.
 */
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Client } = require('pg');

const PHASE = process.argv[2];
const FILES = {
  pre: '010_pre_migrate.sql',
  post: '020_post_migrate.sql',
};

if (!FILES[PHASE]) {
  console.error('Usage: node scripts/apply-sql.js <pre|post>');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

async function main() {
  const path = join(__dirname, '..', 'prisma', 'sql', FILES[PHASE]);
  const sql = readFileSync(path, 'utf8');

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    // Azure PostgreSQL requires TLS. Local development over plain TCP does
    // not offer it, so this follows the connection string rather than being
    // hardcoded either way.
    ssl: /sslmode=(require|verify-full|verify-ca)/.test(process.env.DATABASE_URL)
      ? { rejectUnauthorized: false }
      : undefined,
  });

  console.log(`Applying ${FILES[PHASE]}…`);

  try {
    await client.connect();
    await client.query(sql);
    console.log(`✔ ${FILES[PHASE]} applied`);
  } catch (error) {
    console.error(`✖ ${FILES[PHASE]} failed`);
    console.error(`  ${error.message}`);
    if (error.position) {
      // Point at the offending statement — a 200-line script with a syntax
      // error somewhere in it is otherwise a guessing game.
      const upTo = sql.slice(0, Number(error.position));
      const line = upTo.split('\n').length;
      console.error(`  at line ${line}: ${sql.split('\n')[line - 1]?.trim()}`);
    }
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

void main();
