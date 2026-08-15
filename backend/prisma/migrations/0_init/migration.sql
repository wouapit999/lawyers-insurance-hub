-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('pending', 'active', 'suspended', 'closed');

-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('local', 'google', 'apple');

-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('en', 'fr');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('phone_verification', 'email_verification', 'password_reset', 'mfa_challenge', 'step_up');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('pending', 'verified', 'rejected');

-- CreateEnum
CREATE TYPE "FirmAssetKind" AS ENUM ('office', 'equipment', 'computer', 'server', 'furniture', 'document_archive', 'employee');

-- CreateEnum
CREATE TYPE "RelationshipType" AS ENUM ('spouse', 'child', 'parent', 'dependent');

-- CreateEnum
CREATE TYPE "ProductCode" AS ENUM ('PLI', 'PRAC', 'MED', 'FAM', 'PERS', 'ACC', 'VEH', 'FIRM', 'PROP');

-- CreateEnum
CREATE TYPE "PolicyStatus" AS ENUM ('draft', 'submitted', 'under_review', 'approved', 'active', 'suspended', 'expired', 'cancelled', 'renewed');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('open', 'partial', 'paid', 'overdue', 'void');

-- CreateEnum
CREATE TYPE "InstallmentStatus" AS ENUM ('pending', 'paid', 'overdue', 'waived');

-- CreateEnum
CREATE TYPE "PaymentProviderCode" AS ENUM ('orange_money', 'mtn_momo', 'card', 'bank_transfer');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('initiated', 'pending', 'succeeded', 'failed', 'reversed');

-- CreateEnum
CREATE TYPE "PaymentDirection" AS ENUM ('in', 'out');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('premium_collected', 'claim_paid', 'refund_issued', 'fee_charged');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('submitted', 'investigation', 'assessment', 'approved', 'rejected', 'payment', 'closed');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('policy_certificate', 'receipt', 'claim_evidence', 'contract', 'id_document', 'vehicle_document', 'beneficiary_card', 'other');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('email', 'sms', 'push', 'whatsapp');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('queued', 'sent', 'delivered', 'failed');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "phone_e164" TEXT,
    "password_hash" TEXT,
    "auth_provider" "AuthProvider" NOT NULL DEFAULT 'local',
    "preferred_lang" "Locale" NOT NULL DEFAULT 'fr',
    "email_verified_at" TIMESTAMPTZ(6),
    "phone_verified_at" TIMESTAMPTZ(6),
    "mfa_secret" TEXT,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" "UserStatus" NOT NULL DEFAULT 'pending',
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_fr" TEXT NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "device_id" UUID,
    "ip" TEXT,
    "user_agent" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "replaced_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "label" TEXT,
    "platform" TEXT,
    "push_token" TEXT,
    "biometric_key" TEXT,
    "last_seen_at" TIMESTAMPTZ(6),
    "trusted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "law_firms" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "registration_no" TEXT,
    "address" JSONB,
    "city" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "law_firms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "firm_assets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "firm_id" UUID NOT NULL,
    "kind" "FirmAssetKind" NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "value_xaf" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "acquired_on" DATE,
    "risk_score" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "firm_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lawyer_profiles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "bar_number" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "national_id_no" TEXT,
    "passport_no" TEXT,
    "professional_address" JSONB,
    "personal_address" JSONB,
    "law_firm_id" UUID,
    "specialization" TEXT[],
    "admitted_on" DATE NOT NULL,
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'pending',
    "verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "lawyer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bar_verifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lawyer_id" UUID NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'pending',
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(6),
    "decided_by_id" UUID,
    "rejection_reason" TEXT,
    "registry_snapshot" JSONB,
    "sla_due_at" TIMESTAMPTZ(6),

    CONSTRAINT "bar_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "beneficiaries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lawyer_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "relationship" "RelationshipType" NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "national_id_no" TEXT,
    "phone_e164" TEXT,
    "proof_document_id" UUID,
    "medical_coverage" BOOLEAN NOT NULL DEFAULT false,
    "card_number" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "beneficiaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lawyer_id" UUID NOT NULL,
    "registration_number" TEXT NOT NULL,
    "chassis_number" TEXT NOT NULL,
    "engine_number" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "value_xaf" BIGINT NOT NULL,
    "seats" INTEGER,
    "usage" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" "ProductCode" NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_fr" TEXT NOT NULL,
    "description_en" TEXT,
    "description_fr" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_fr" TEXT NOT NULL,
    "coverage" JSONB NOT NULL,
    "base_premium_xaf" BIGINT NOT NULL,
    "installment_options" INTEGER[] DEFAULT ARRAY[1, 2, 4, 12]::INTEGER[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rating_tables" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "factors" JSONB NOT NULL,
    "effective_from" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rating_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lawyer_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "rating_table_id" UUID NOT NULL,
    "factors" JSONB NOT NULL,
    "premium_xaf" BIGINT NOT NULL,
    "installments" INTEGER NOT NULL DEFAULT 1,
    "installment_xaf" BIGINT NOT NULL,
    "breakdown" JSONB NOT NULL,
    "valid_until" TIMESTAMPTZ(6) NOT NULL,
    "converted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "policy_number" TEXT NOT NULL,
    "lawyer_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "rating_table_id" UUID NOT NULL,
    "quote_id" UUID,
    "status" "PolicyStatus" NOT NULL DEFAULT 'draft',
    "premium_xaf" BIGINT NOT NULL,
    "effective_from" DATE,
    "effective_to" DATE,
    "renewed_from_id" UUID,
    "subject_ref" JSONB,
    "sold_by_agent_id" UUID,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_beneficiaries" (
    "policy_id" UUID NOT NULL,
    "beneficiary_id" UUID NOT NULL,
    "coverage_level" TEXT NOT NULL DEFAULT 'standard',

    CONSTRAINT "policy_beneficiaries_pkey" PRIMARY KEY ("policy_id","beneficiary_id")
);

-- CreateTable
CREATE TABLE "policy_events" (
    "id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "from_status" "PolicyStatus",
    "to_status" "PolicyStatus" NOT NULL,
    "actor_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "invoice_no" TEXT NOT NULL,
    "total_xaf" BIGINT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'open',
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installments" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "amount_xaf" BIGINT NOT NULL,
    "due_on" DATE NOT NULL,
    "status" "InstallmentStatus" NOT NULL DEFAULT 'pending',
    "paid_at" TIMESTAMPTZ(6),
    "retry_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "installments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "installment_id" UUID,
    "claim_id" UUID,
    "refund_of_id" UUID,
    "direction" "PaymentDirection" NOT NULL,
    "provider" "PaymentProviderCode" NOT NULL,
    "provider_ref" TEXT,
    "amount_xaf" BIGINT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'initiated',
    "idempotency_key" TEXT NOT NULL,
    "msisdn" TEXT,
    "failure_reason" TEXT,
    "raw_callback" JSONB,
    "reconciled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "entry_type" "LedgerEntryType" NOT NULL,
    "amount_xaf" BIGINT NOT NULL,
    "balance_after" BIGINT,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider" "PaymentProviderCode" NOT NULL,
    "run_date" DATE NOT NULL,
    "matched_count" INTEGER NOT NULL DEFAULT 0,
    "orphan_count" INTEGER NOT NULL DEFAULT 0,
    "mismatch_count" INTEGER NOT NULL DEFAULT 0,
    "findings" JSONB,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claims" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "claim_number" TEXT NOT NULL,
    "policy_id" UUID NOT NULL,
    "filed_by_id" UUID NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'submitted',
    "incident_at" TIMESTAMPTZ(6) NOT NULL,
    "incident_place" TEXT,
    "incident_geo" JSONB,
    "description" TEXT NOT NULL,
    "claimed_xaf" BIGINT,
    "approved_xaf" BIGINT,
    "fraud_score" DECIMAL(4,3),
    "fraud_factors" JSONB,
    "assigned_to_id" UUID,
    "sla_due_at" TIMESTAMPTZ(6),
    "rejection_reason" TEXT,
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_events" (
    "id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "from_status" "ClaimStatus",
    "to_status" "ClaimStatus" NOT NULL,
    "actor_id" UUID NOT NULL,
    "note" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "claim_id" UUID,
    "kind" "DocumentKind" NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "blob_path" TEXT NOT NULL,
    "content_sha256" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "ocr_text" TEXT,
    "language" TEXT,
    "entity_ref" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "template_key" TEXT NOT NULL,
    "locale" "Locale" NOT NULL,
    "payload" JSONB,
    "status" "NotificationStatus" NOT NULL DEFAULT 'queued',
    "sent_at" TIMESTAMPTZ(6),
    "failure_reason" TEXT,
    "dedupe_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_e164_key" ON "users"("phone_e164");

-- CreateIndex
CREATE INDEX "users_tenant_id_status_idx" ON "users"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_revoked_at_idx" ON "sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "devices_user_id_fingerprint_key" ON "devices"("user_id", "fingerprint");

-- CreateIndex
CREATE INDEX "otp_codes_user_id_purpose_consumed_at_idx" ON "otp_codes"("user_id", "purpose", "consumed_at");

-- CreateIndex
CREATE INDEX "firm_assets_firm_id_kind_idx" ON "firm_assets"("firm_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "lawyer_profiles_user_id_key" ON "lawyer_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "lawyer_profiles_bar_number_key" ON "lawyer_profiles"("bar_number");

-- CreateIndex
CREATE INDEX "lawyer_profiles_tenant_id_verification_status_idx" ON "lawyer_profiles"("tenant_id", "verification_status");

-- CreateIndex
CREATE INDEX "bar_verifications_tenant_id_status_submitted_at_idx" ON "bar_verifications"("tenant_id", "status", "submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "beneficiaries_card_number_key" ON "beneficiaries"("card_number");

-- CreateIndex
CREATE INDEX "beneficiaries_lawyer_id_idx" ON "beneficiaries"("lawyer_id");

-- CreateIndex
CREATE INDEX "vehicles_lawyer_id_idx" ON "vehicles"("lawyer_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_tenant_id_registration_number_key" ON "vehicles"("tenant_id", "registration_number");

-- CreateIndex
CREATE UNIQUE INDEX "products_code_key" ON "products"("code");

-- CreateIndex
CREATE UNIQUE INDEX "plans_product_id_code_key" ON "plans"("product_id", "code");

-- CreateIndex
CREATE INDEX "rating_tables_plan_id_effective_from_idx" ON "rating_tables"("plan_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "rating_tables_plan_id_version_key" ON "rating_tables"("plan_id", "version");

-- CreateIndex
CREATE INDEX "quotes_lawyer_id_created_at_idx" ON "quotes"("lawyer_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "policies_policy_number_key" ON "policies"("policy_number");

-- CreateIndex
CREATE UNIQUE INDEX "policies_quote_id_key" ON "policies"("quote_id");

-- CreateIndex
CREATE INDEX "policies_lawyer_id_status_idx" ON "policies"("lawyer_id", "status");

-- CreateIndex
CREATE INDEX "policies_tenant_id_status_idx" ON "policies"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "policies_effective_to_idx" ON "policies"("effective_to");

-- CreateIndex
CREATE INDEX "policy_events_policy_id_created_at_idx" ON "policy_events"("policy_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoice_no_key" ON "invoices"("invoice_no");

-- CreateIndex
CREATE INDEX "invoices_policy_id_status_idx" ON "invoices"("policy_id", "status");

-- CreateIndex
CREATE INDEX "installments_status_due_on_idx" ON "installments"("status", "due_on");

-- CreateIndex
CREATE UNIQUE INDEX "installments_invoice_id_seq_key" ON "installments"("invoice_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "payments"("idempotency_key");

-- CreateIndex
CREATE INDEX "payments_tenant_id_status_created_at_idx" ON "payments"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_provider_ref_key" ON "payments"("provider", "provider_ref");

-- CreateIndex
CREATE INDEX "ledger_entries_tenant_id_created_at_idx" ON "ledger_entries"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_runs_provider_run_date_key" ON "reconciliation_runs"("provider", "run_date");

-- CreateIndex
CREATE UNIQUE INDEX "claims_claim_number_key" ON "claims"("claim_number");

-- CreateIndex
CREATE INDEX "claims_tenant_id_status_sla_due_at_idx" ON "claims"("tenant_id", "status", "sla_due_at");

-- CreateIndex
CREATE INDEX "claims_policy_id_idx" ON "claims"("policy_id");

-- CreateIndex
CREATE INDEX "claim_events_claim_id_created_at_idx" ON "claim_events"("claim_id", "created_at");

-- CreateIndex
CREATE INDEX "documents_owner_id_kind_idx" ON "documents"("owner_id", "kind");

-- CreateIndex
CREATE INDEX "documents_claim_id_idx" ON "documents"("claim_id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications"("dedupe_key");

-- CreateIndex
CREATE INDEX "notifications_user_id_status_idx" ON "notifications"("user_id", "status");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_entity_type_entity_id_idx" ON "audit_logs"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_codes" ADD CONSTRAINT "otp_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "firm_assets" ADD CONSTRAINT "firm_assets_firm_id_fkey" FOREIGN KEY ("firm_id") REFERENCES "law_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lawyer_profiles" ADD CONSTRAINT "lawyer_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lawyer_profiles" ADD CONSTRAINT "lawyer_profiles_law_firm_id_fkey" FOREIGN KEY ("law_firm_id") REFERENCES "law_firms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bar_verifications" ADD CONSTRAINT "bar_verifications_lawyer_id_fkey" FOREIGN KEY ("lawyer_id") REFERENCES "lawyer_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bar_verifications" ADD CONSTRAINT "bar_verifications_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "beneficiaries" ADD CONSTRAINT "beneficiaries_lawyer_id_fkey" FOREIGN KEY ("lawyer_id") REFERENCES "lawyer_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_lawyer_id_fkey" FOREIGN KEY ("lawyer_id") REFERENCES "lawyer_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rating_tables" ADD CONSTRAINT "rating_tables_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_rating_table_id_fkey" FOREIGN KEY ("rating_table_id") REFERENCES "rating_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_lawyer_id_fkey" FOREIGN KEY ("lawyer_id") REFERENCES "lawyer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_rating_table_id_fkey" FOREIGN KEY ("rating_table_id") REFERENCES "rating_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_renewed_from_id_fkey" FOREIGN KEY ("renewed_from_id") REFERENCES "policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policies" ADD CONSTRAINT "policies_sold_by_agent_id_fkey" FOREIGN KEY ("sold_by_agent_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_beneficiaries" ADD CONSTRAINT "policy_beneficiaries_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_beneficiaries" ADD CONSTRAINT "policy_beneficiaries_beneficiary_id_fkey" FOREIGN KEY ("beneficiary_id") REFERENCES "beneficiaries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_events" ADD CONSTRAINT "policy_events_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installments" ADD CONSTRAINT "installments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_installment_id_fkey" FOREIGN KEY ("installment_id") REFERENCES "installments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_refund_of_id_fkey" FOREIGN KEY ("refund_of_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_filed_by_id_fkey" FOREIGN KEY ("filed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_events" ADD CONSTRAINT "claim_events_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_events" ADD CONSTRAINT "claim_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

