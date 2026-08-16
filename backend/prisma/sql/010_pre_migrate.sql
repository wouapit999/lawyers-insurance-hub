-- ---------------------------------------------------------------------------
-- 010_pre_migrate.sql — run BEFORE `prisma migrate deploy`.
-- Extensions and the uuidv7 generator the table defaults depend on.
-- Idempotent: safe to re-run on every deploy.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_bytes, digest
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy search on lawyer directory

-- ---------------------------------------------------------------------------
-- uuid_generate_v7()
--
-- PostgreSQL 18 ships uuidv7() natively; we target 16, so we implement the
-- RFC 9562 layout ourselves: 48 bits of Unix milliseconds, version nibble 7,
-- variant bits 10, and 74 bits of randomness.
--
-- Why not v4: v7 is time-ordered, so inserts land at the right edge of the
-- B-tree instead of scattering across it. On the tables that grow fastest
-- (payments, claim_events, audit_logs) that is the difference between an
-- index that stays dense and one that fragments.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION uuid_generate_v7()
RETURNS uuid
AS $$
DECLARE
  unix_ts_ms bytea;
  uuid_bytes bytea;
BEGIN
  unix_ts_ms := substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3);

  -- 10 random bytes fill the rest; the version and variant nibbles are
  -- overwritten below.
  uuid_bytes := unix_ts_ms || gen_random_bytes(10);

  -- Plain integer masking rather than bit-string concatenation. The earlier
  -- `b'0111' || x::bit(8)` form produced a 12-bit value whose cast back to
  -- bit(8) kept the WRONG eight bits, so every id came out with version 0 —
  -- a valid UUID that no longer identified itself as v7.
  --
  -- byte 6: keep the low nibble, force the high nibble to 7  (0x70)
  uuid_bytes := set_byte(uuid_bytes, 6, (get_byte(uuid_bytes, 6) & 15) | 112);
  -- byte 8: keep the low 6 bits, force the top two to 10     (0x80)
  uuid_bytes := set_byte(uuid_bytes, 8, (get_byte(uuid_bytes, 8) & 63) | 128);

  RETURN encode(uuid_bytes, 'hex')::uuid;
END;
$$ LANGUAGE plpgsql VOLATILE;

COMMENT ON FUNCTION uuid_generate_v7() IS
  'RFC 9562 UUIDv7 — time-ordered primary keys for insert-heavy tables.';
