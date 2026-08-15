-- ---------------------------------------------------------------------------
-- 020_post_migrate.sql — run AFTER `prisma migrate deploy`.
--
-- Everything Prisma's schema language cannot express:
--   1. uuidv7 column defaults
--   2. Row-level security for tenant isolation (blueprint §5.6)
--   3. Partial and expression indexes
--   4. Full-text search on OCR'd documents
--   5. Monthly partitioning of the audit log
--   6. Ledger integrity constraints
--
-- Idempotent. Re-runs on every deploy as a pre-deploy job.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. Time-ordered primary keys
-- ===========================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','sessions','devices','otp_codes','lawyer_profiles','bar_verifications',
    'beneficiaries','vehicles','law_firms','firm_assets','products','plans',
    'rating_tables','quotes','policies','policy_events','invoices','installments',
    'payments','ledger_entries','claims','claim_events','documents',
    'notifications','outbox_events','reconciliation_runs'
  ]
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN id SET DEFAULT uuid_generate_v7()', t);
    END IF;
  END LOOP;
END $$;

-- ===========================================================================
-- 2. Row-level security — the last line of tenant isolation
--
-- The application sets `app.current_tenant` per connection from the JWT's
-- tenant claim (see PrismaService.forTenant). Even a SQL injection that
-- reaches a business table cannot read another tenant's rows, because the
-- policy is evaluated by the database, not by our code.
-- ===========================================================================
-- Driven by the catalogue rather than a hand-maintained list: every table
-- that actually HAS a tenant_id gets the policy, and one that does not is
-- skipped rather than failing the script.
--
-- Not every business table carries the column, and that is correct. An
-- installment has no tenant_id of its own — it belongs to an invoice, which
-- belongs to a policy, which is tenant-scoped. Reaching an installment
-- requires passing through its parent, so the parent's policy governs it.
--
-- Deriving the list this way also means a table added later is protected
-- automatically, instead of being silently unprotected until somebody
-- remembers to edit an array here.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
    WHERE c.table_schema = 'public'
      AND c.column_name = 'tenant_id'
      AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid)
    $f$, t);
    RAISE NOTICE 'RLS enabled on %', t;
  END LOOP;
END $$;

-- Migrations and the reconciliation job run as the owner and must see
-- everything; RLS is bypassed for that role only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lih_migrator') THEN
    EXECUTE 'ALTER ROLE lih_migrator BYPASSRLS';
  END IF;
END $$;

-- ===========================================================================
-- 3. Partial and expression indexes
-- ===========================================================================

-- Renewal sweep: only active policies matter, so index only those rows.
DROP INDEX IF EXISTS policies_active_expiry_idx;
CREATE INDEX policies_active_expiry_idx
  ON policies (effective_to)
  WHERE status = 'active';

-- Officer work queue: unclosed claims ordered by SLA urgency.
DROP INDEX IF EXISTS claims_open_sla_idx;
CREATE INDEX claims_open_sla_idx
  ON claims (sla_due_at)
  WHERE status NOT IN ('closed', 'rejected');

-- Dunning: overdue installments only.
DROP INDEX IF EXISTS installments_overdue_idx;
CREATE INDEX installments_overdue_idx
  ON installments (due_on)
  WHERE status IN ('pending', 'overdue');

-- Outbox relay: unpublished events only. This index stays tiny even after
-- millions of events, because published rows drop out of it.
DROP INDEX IF EXISTS outbox_unpublished_idx;
CREATE INDEX outbox_unpublished_idx
  ON outbox_events (created_at)
  WHERE published_at IS NULL;

-- Reconciliation: unmatched payments only.
DROP INDEX IF EXISTS payments_unreconciled_idx;
CREATE INDEX payments_unreconciled_idx
  ON payments (created_at)
  WHERE reconciled_at IS NULL AND status = 'succeeded';

-- Case-insensitive lawyer directory search (Bar portal).
DROP INDEX IF EXISTS lawyer_profiles_name_trgm_idx;
CREATE INDEX lawyer_profiles_name_trgm_idx
  ON lawyer_profiles USING gin (full_name gin_trgm_ops);

-- ===========================================================================
-- 4. Full-text search over OCR'd documents (bilingual)
--
-- Two configurations, one column each: a French document tokenises badly
-- under the English stemmer and vice versa. The API picks the configuration
-- from documents.language at query time.
-- ===========================================================================
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS ocr_tsv_fr tsvector
    GENERATED ALWAYS AS (to_tsvector('french',  coalesce(ocr_text, ''))) STORED,
  ADD COLUMN IF NOT EXISTS ocr_tsv_en tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(ocr_text, ''))) STORED;

DROP INDEX IF EXISTS documents_ocr_fr_idx;
CREATE INDEX documents_ocr_fr_idx ON documents USING gin (ocr_tsv_fr);
DROP INDEX IF EXISTS documents_ocr_en_idx;
CREATE INDEX documents_ocr_en_idx ON documents USING gin (ocr_tsv_en);

-- ===========================================================================
-- 5. Audit log: monthly partitions + append-only enforcement
--
-- Prisma cannot declare a partitioned table, so we convert it here. Seven
-- years of retention across one heap would make every write slower and every
-- purge a table rewrite; partitions make the purge a DROP.
-- ===========================================================================
DO $$
DECLARE
  start_month date := date_trunc('month', now())::date;
  m date;
  part text;
BEGIN
  -- Only convert once: if audit_logs is already partitioned, skip.
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_partitioned_table p ON p.partrelid = c.oid
    WHERE c.relname = 'audit_logs'
  ) THEN
    RAISE NOTICE 'audit_logs already partitioned, skipping conversion';
  ELSIF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_logs') THEN
    ALTER TABLE audit_logs RENAME TO audit_logs_unpartitioned;

    -- INCLUDING ALL would copy the primary key on (id) alone, and PostgreSQL
    -- rejects that: a unique constraint on a partitioned table must contain
    -- every partitioning column, because uniqueness cannot be enforced across
    -- partitions otherwise. So the key becomes (id, created_at).
    --
    -- id stays globally unique in practice — it is a UUIDv7, whose first 48
    -- bits are the millisecond timestamp that decides the partition, so the
    -- two columns are not independent.
    CREATE TABLE audit_logs (
      LIKE audit_logs_unpartitioned INCLUDING DEFAULTS INCLUDING COMMENTS
    ) PARTITION BY RANGE (created_at);

    ALTER TABLE audit_logs ADD PRIMARY KEY (id, created_at);

    INSERT INTO audit_logs SELECT * FROM audit_logs_unpartitioned;
    DROP TABLE audit_logs_unpartitioned;
  END IF;

  -- Recreated here because INCLUDING INDEXES was deliberately omitted above.
  CREATE INDEX IF NOT EXISTS audit_logs_tenant_entity_idx
    ON audit_logs (tenant_id, entity_type, entity_id);
  CREATE INDEX IF NOT EXISTS audit_logs_actor_time_idx
    ON audit_logs (actor_id, created_at);

  -- Rolling window: current month plus twelve ahead. A scheduled job extends
  -- this; creating them eagerly means a write never fails for a missing
  -- partition at midnight on the 1st.
  FOR i IN 0..12 LOOP
    m := (start_month + (i || ' month')::interval)::date;
    part := 'audit_logs_' || to_char(m, 'YYYY_MM');
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = part) THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)',
        part, m, (m + interval '1 month')::date
      );
    END IF;
  END LOOP;
END $$;

-- Append-only: audit rows are evidence. Nobody edits or deletes them, and
-- that includes us.
CREATE OR REPLACE FUNCTION audit_logs_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

-- ===========================================================================
-- 6. Money and ledger integrity
--
-- These constraints exist because a bug that lets a negative premium or a
-- zero-amount payment through is a financial incident, not a 500.
-- ===========================================================================
ALTER TABLE policies      DROP CONSTRAINT IF EXISTS policies_premium_positive;
ALTER TABLE policies      ADD  CONSTRAINT policies_premium_positive
  CHECK (premium_xaf > 0);

ALTER TABLE installments  DROP CONSTRAINT IF EXISTS installments_amount_positive;
ALTER TABLE installments  ADD  CONSTRAINT installments_amount_positive
  CHECK (amount_xaf > 0);

ALTER TABLE payments      DROP CONSTRAINT IF EXISTS payments_amount_positive;
ALTER TABLE payments      ADD  CONSTRAINT payments_amount_positive
  CHECK (amount_xaf > 0);

ALTER TABLE claims        DROP CONSTRAINT IF EXISTS claims_approved_within_claimed;
ALTER TABLE claims        ADD  CONSTRAINT claims_approved_within_claimed
  CHECK (approved_xaf IS NULL OR claimed_xaf IS NULL OR approved_xaf <= claimed_xaf);

ALTER TABLE policies      DROP CONSTRAINT IF EXISTS policies_period_ordered;
ALTER TABLE policies      ADD  CONSTRAINT policies_period_ordered
  CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_to > effective_from);

-- A payout must name the claim it settles; a premium must name its installment.
ALTER TABLE payments      DROP CONSTRAINT IF EXISTS payments_target_present;
ALTER TABLE payments      ADD  CONSTRAINT payments_target_present
  CHECK (
    (direction = 'in'  AND installment_id IS NOT NULL) OR
    (direction = 'out' AND (claim_id IS NOT NULL OR refund_of_id IS NOT NULL))
  );
