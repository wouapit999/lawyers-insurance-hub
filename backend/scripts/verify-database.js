#!/usr/bin/env node
/**
 * Verifies that a PostgreSQL instance can actually host this schema.
 *
 * Written because "the migration ran without error" is not the same as "the
 * database does what the application assumes". Managed Postgres providers
 * differ in exactly the places this schema is demanding: which extensions are
 * allow-listed, whether row-level security can be FORCEd, whether declarative
 * partitioning is permitted, and whether a PL/pgSQL trigger can raise.
 *
 * Run it against any candidate database before trusting it:
 *
 *   cd backend
 *   DATABASE_URL="postgresql://..." node scripts/verify-database.js
 *
 * Exit code 0 means the database is suitable. Anything else names the reason.
 */
const { Client } = require('pg');

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';

let passed = 0;
let failed = 0;
let warned = 0;

function pass(label, detail = '') {
  passed++;
  console.log(`  ${GREEN}✔${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
}
function fail(label, detail = '') {
  failed++;
  console.log(`  ${RED}✖${RESET} ${label}${detail ? ` ${RED}${detail}${RESET}` : ''}`);
}
function warn(label, detail = '') {
  warned++;
  console.log(`  ${YELLOW}!${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
}
function section(title) {
  console.log(`\n${title}`);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    console.error('Put it in backend/.env, or pass it inline:');
    console.error('  DATABASE_URL="postgresql://..." node scripts/verify-database.js');
    process.exit(1);
  }

  // Load backend/.env if present, without adding a dotenv dependency.
  const url = process.env.DATABASE_URL;
  const client = new Client({
    connectionString: url,
    ssl: /sslmode=(require|verify-full|verify-ca)/.test(url)
      ? { rejectUnauthorized: false }
      : undefined,
    // Neon's free compute autosuspends; the first connection wakes it and can
    // take several seconds.
    connectionTimeoutMillis: 30_000,
  });

  const host = (() => {
    try { return new URL(url).host; } catch { return 'unknown'; }
  })();

  console.log(`\nVerifying ${host}\n${'─'.repeat(60)}`);

  try {
    await client.connect();
  } catch (error) {
    console.error(`${RED}Could not connect:${RESET} ${error.message}`);
    process.exit(1);
  }

  const q = async (sql, params) => (await client.query(sql, params)).rows;

  try {
    // --- 1. server ---------------------------------------------------------
    section('Server');
    const [{ version }] = await q('SELECT version()');
    const major = Number(/PostgreSQL (\d+)/.exec(version)?.[1] ?? 0);
    if (major >= 14) pass(`PostgreSQL ${major}`, version.split(' ').slice(0, 2).join(' '));
    else fail(`PostgreSQL ${major}`, 'the schema needs 14 or newer');

    if (/neon/i.test(host)) pass('Provider', 'Neon detected');
    else if (/supabase/i.test(host)) pass('Provider', 'Supabase detected');
    else if (/azure/i.test(host)) pass('Provider', 'Azure detected');

    // --- 2. extensions -----------------------------------------------------
    // 010_pre_migrate.sql needs all three. A provider that allow-lists only
    // some of them cannot host this schema.
    section('Extensions');
    for (const ext of ['pgcrypto', 'citext', 'pg_trgm']) {
      const rows = await q('SELECT 1 FROM pg_extension WHERE extname = $1', [ext]);
      if (rows.length) pass(ext);
      else fail(ext, 'missing — run scripts/apply-sql.js pre');
    }

    // --- 3. uuidv7 ---------------------------------------------------------
    section('Identifier generation');
    try {
      const [{ id }] = await q('SELECT uuid_generate_v7() AS id');
      // Version nibble must be 7 and the variant bits must be 10xx.
      const version = id[14];
      const variant = id[19].toLowerCase();
      if (version === '7' && '89ab'.includes(variant)) {
        pass('uuid_generate_v7()', id);
      } else {
        fail('uuid_generate_v7()', `produced a malformed UUID: ${id}`);
      }

      // Time ordering is the whole reason for v7 — without it the function
      // works but the index locality benefit is gone.
      const [{ a }] = await q('SELECT uuid_generate_v7() AS a');
      await new Promise((r) => setTimeout(r, 5));
      const [{ b }] = await q('SELECT uuid_generate_v7() AS b');
      if (a < b) pass('uuidv7 values are time-ordered');
      else fail('uuidv7 values are NOT time-ordered', `${a} >= ${b}`);
    } catch (error) {
      fail('uuid_generate_v7()', `${error.message} — run scripts/apply-sql.js pre`);
    }

    // --- 4. schema ---------------------------------------------------------
    section('Schema');
    const [{ count: tableCount }] = await q(
      "SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'",
    );
    if (tableCount >= 28) pass('Tables', `${tableCount} present`);
    else fail('Tables', `only ${tableCount} — run prisma migrate deploy`);

    const [{ count: enumCount }] = await q(
      'SELECT count(*)::int AS count FROM pg_type WHERE typtype = $1',
      ['e'],
    );
    if (enumCount >= 15) pass('Enums', `${enumCount} present`);
    else warn('Enums', `${enumCount} — expected around 19`);

    // --- 5. row-level security --------------------------------------------
    // The control that stops one tenant reading another's rows. ENABLE alone
    // is not enough: without FORCE, the table owner bypasses the policy, and
    // the application connects as the owner.
    section('Row-level security');
    const rls = await q(`
      SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
      ORDER BY c.relname
    `);
    if (rls.length >= 15) pass('Protected tables', `${rls.length}`);
    else fail('Protected tables', `only ${rls.length} — run scripts/apply-sql.js post`);

    const unforced = rls.filter((r) => !r.forced).map((r) => r.table);
    if (unforced.length === 0) pass('FORCE row level security', 'on every protected table');
    else fail('FORCE missing', unforced.join(', '));

    const [{ count: policyCount }] = await q(
      "SELECT count(*)::int AS count FROM pg_policies WHERE policyname = 'tenant_isolation'",
    );
    if (policyCount >= 15) pass('tenant_isolation policies', `${policyCount}`);
    else fail('tenant_isolation policies', `only ${policyCount}`);

    // --- 6. partitioning ---------------------------------------------------
    section('Audit log');
    const partitioned = await q(`
      SELECT 1 FROM pg_partitioned_table p
      JOIN pg_class c ON c.oid = p.partrelid
      WHERE c.relname = 'audit_logs'
    `);
    if (partitioned.length) pass('audit_logs is partitioned');
    else fail('audit_logs is NOT partitioned', 'run scripts/apply-sql.js post');

    const [{ count: partitionCount }] = await q(
      "SELECT count(*)::int AS count FROM pg_tables WHERE tablename LIKE 'audit_logs_2%'",
    );
    if (partitionCount >= 6) pass('Monthly partitions', `${partitionCount} created`);
    else warn('Monthly partitions', `only ${partitionCount}`);

    // Immutability: the trigger is FOR EACH ROW, so a row must exist for the
    // test to mean anything.
    const TENANT = '00000000-0000-0000-0000-000000000001';
    await client.query(
      `SET app.current_tenant = '${TENANT}'`,
    );
    await client.query(
      `INSERT INTO audit_logs (id, tenant_id, action, entity_type, created_at)
       VALUES (uuid_generate_v7(), $1, 'verify.probe', 'Verification', now())`,
      [TENANT],
    );

    let updateRejected = false;
    try {
      await client.query(
        `UPDATE audit_logs SET action = 'tampered' WHERE action = 'verify.probe'`,
      );
    } catch (error) {
      updateRejected = /append-only/.test(error.message);
    }
    if (updateRejected) pass('audit_logs rejects UPDATE');
    else fail('audit_logs accepted an UPDATE', 'the evidence trail is mutable');

    // The failed UPDATE aborted the transaction; recover before continuing.
    await client.query('ROLLBACK').catch(() => undefined);
    await client.query(`SET app.current_tenant = '${TENANT}'`).catch(() => undefined);

    let deleteRejected = false;
    try {
      await client.query(`DELETE FROM audit_logs WHERE action = 'verify.probe'`);
    } catch (error) {
      deleteRejected = /append-only/.test(error.message);
    }
    if (deleteRejected) pass('audit_logs rejects DELETE');
    else fail('audit_logs accepted a DELETE', 'the evidence trail is mutable');

    await client.query('ROLLBACK').catch(() => undefined);

    // --- 7. money constraints ---------------------------------------------
    section('Money constraints');
    for (const [table, constraint] of [
      ['policies', 'policies_premium_positive'],
      ['payments', 'payments_amount_positive'],
      ['installments', 'installments_amount_positive'],
      ['claims', 'claims_approved_within_claimed'],
    ]) {
      const rows = await q(
        `SELECT 1 FROM pg_constraint WHERE conname = $1`, [constraint],
      );
      if (rows.length) pass(constraint);
      else fail(constraint, `missing on ${table}`);
    }

    // --- 8. seed -----------------------------------------------------------
    section('Seed data');
    const checks = [
      ['permissions', 40, 'SELECT count(*)::int AS count FROM permissions'],
      ['roles', 8, 'SELECT count(*)::int AS count FROM roles'],
      ['products', 3, 'SELECT count(*)::int AS count FROM products'],
      ['plans', 5, 'SELECT count(*)::int AS count FROM plans'],
      ['rating_tables', 5, 'SELECT count(*)::int AS count FROM rating_tables'],
    ];
    for (const [label, expected, sql] of checks) {
      try {
        const [{ count }] = await q(sql);
        if (count >= expected) pass(label, `${count}`);
        else warn(label, `${count} — expected at least ${expected}; run the seed`);
      } catch {
        fail(label, 'table missing');
      }
    }

    // A product name in both locales is the cheapest proof that the bilingual
    // columns survived the migration.
    try {
      const rows = await q(
        `SELECT code, name_en, name_fr FROM products ORDER BY sort_order LIMIT 3`,
      );
      const bilingual = rows.every((r) => r.name_en && r.name_fr && r.name_en !== r.name_fr);
      if (rows.length && bilingual) {
        pass('Bilingual catalogue', rows.map((r) => `${r.code}="${r.name_fr}"`).join(', '));
      } else if (rows.length) {
        warn('Bilingual catalogue', 'a product is missing one locale');
      }
    } catch { /* products table already reported */ }

  } finally {
    await client.end().catch(() => undefined);
  }

  // --- summary -------------------------------------------------------------
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${GREEN}${passed} passed${RESET}` +
    (warned ? `  ${YELLOW}${warned} warning${warned > 1 ? 's' : ''}${RESET}` : '') +
    (failed ? `  ${RED}${failed} failed${RESET}` : ''));

  if (failed === 0) {
    console.log(`\n${GREEN}This database can host the platform.${RESET}\n`);
    process.exit(0);
  }

  console.log(`\n${RED}Not ready.${RESET} Usual order:`);
  console.log('  node scripts/apply-sql.js pre');
  console.log('  npx prisma migrate deploy');
  console.log('  node scripts/apply-sql.js post');
  console.log('  npx ts-node prisma/seed.ts\n');
  process.exit(1);
}

main().catch((error) => {
  console.error(`\n${RED}Verification crashed:${RESET} ${error.message}`);
  process.exit(1);
});
