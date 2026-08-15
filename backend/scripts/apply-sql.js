#!/usr/bin/env node
/**
 * Applies the raw SQL that Prisma's schema language cannot express.
 *
 * Order matters and is enforced here:
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
 */
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { PrismaClient } = require('@prisma/client');

const PHASE = process.argv[2];
const FILES = {
  pre: '010_pre_migrate.sql',
  post: '020_post_migrate.sql',
};

if (!FILES[PHASE]) {
  console.error(`Usage: node scripts/apply-sql.js <pre|post>`);
  process.exit(1);
}

async function main() {
  const path = join(__dirname, '..', 'prisma', 'sql', FILES[PHASE]);
  const sql = readFileSync(path, 'utf8');
  const prisma = new PrismaClient();

  console.log(`Applying ${FILES[PHASE]}…`);
  try {
    // $executeRawUnsafe takes the whole script; the DO blocks and functions
    // inside contain semicolons, so splitting on ';' would corrupt them.
    await prisma.$executeRawUnsafe(sql);
    console.log(`✔ ${FILES[PHASE]} applied`);
  } catch (error) {
    console.error(`✖ ${FILES[PHASE]} failed:`, error.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
