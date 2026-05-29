-- E-137 — BRD Addendum V0.2 §8 (Wallet & Charging Model).
--   §8.1 NBFC prepaid wallet (Model 1): funded in advance; an empty wallet
--        blocks initiation of new chargeable activity; manual top-up + auto-NACH.
--   §8.2 Configurable, NBFC-scoped deduction engine: an admin-maintained,
--        open-ended chargeable-item catalogue; each fired trigger posts a
--        deduction line to the prepaid wallet ledger; the month's lines totalled
--        are the GST statement. Admin may post one-off manual deductions.
--
-- The dealer is NOT a party to this engine. iTarang admin configures it; the
-- NBFC is the billing party. Strictly additive + idempotent.

-- §8.1 — one prepaid wallet per NBFC tenant.
CREATE TABLE IF NOT EXISTS "nbfc_wallets" (
  "id"                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"                 uuid NOT NULL,
  "balance"                   numeric(14, 2) NOT NULL DEFAULT 0,
  "currency"                  varchar(8) NOT NULL DEFAULT 'INR',
  "auto_nach_enabled"         boolean NOT NULL DEFAULT false,
  "auto_nach_threshold"       numeric(14, 2),   -- NBFC-set trigger threshold
  "auto_nach_recharge_amount" numeric(14, 2),   -- NBFC-set recharge amount
  "auto_nach_mandate_ref"     varchar(120),     -- NBFC→iTarang mandate (onboarding Wallet Setup)
  "created_at"                timestamptz NOT NULL DEFAULT now(),
  "updated_at"                timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "nbfc_wallets_tenant_unique"
  ON "nbfc_wallets" ("tenant_id");

-- §8.2 — chargeable-item catalogue. tenant_id NULL = a global/default item
-- applicable to all NBFCs; a non-null tenant_id overrides per NBFC.
CREATE TABLE IF NOT EXISTS "nbfc_charge_catalogue" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"          uuid,
  "name"               varchar(160) NOT NULL,
  "type"               varchar(20) NOT NULL,   -- service_usage | platform_fee | disbursal_fee | other
  "amount"             numeric(14, 2) NOT NULL,
  "trigger"            varchar(24) NOT NULL,    -- on_api_execution | on_vkyc_run | on_disbursal | monthly | manual
  "status"             varchar(12) NOT NULL DEFAULT 'active',  -- active | inactive
  "commercial_doc_url" text,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  "updated_at"         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "nbfc_charge_catalogue_tenant_trigger_idx"
  ON "nbfc_charge_catalogue" ("tenant_id", "trigger", "status");

DO $do$ BEGIN
  ALTER TABLE "nbfc_charge_catalogue"
    ADD CONSTRAINT "nbfc_charge_catalogue_type_check"
    CHECK ("type" IN ('service_usage', 'platform_fee', 'disbursal_fee', 'other'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: nbfc_charge_catalogue_type_check exists';
END; $do$;

DO $do$ BEGIN
  ALTER TABLE "nbfc_charge_catalogue"
    ADD CONSTRAINT "nbfc_charge_catalogue_trigger_check"
    CHECK ("trigger" IN ('on_api_execution', 'on_vkyc_run', 'on_disbursal', 'monthly', 'manual'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: nbfc_charge_catalogue_trigger_check exists';
END; $do$;

DO $do$ BEGIN
  ALTER TABLE "nbfc_charge_catalogue"
    ADD CONSTRAINT "nbfc_charge_catalogue_status_check"
    CHECK ("status" IN ('active', 'inactive'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: nbfc_charge_catalogue_status_check exists';
END; $do$;

-- §8.2 — append-only wallet ledger. Each fired trigger / top-up posts one line
-- (what, when, which lead, which rule, amount). amount: negative = debit,
-- positive = credit (top-up). balance_after snapshots the running balance.
CREATE TABLE IF NOT EXISTS "nbfc_wallet_ledger" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"         uuid NOT NULL,
  "catalogue_item_id" uuid,
  "kind"              varchar(20) NOT NULL,    -- charge | manual_deduction | topup | adjustment
  "type"              varchar(20),             -- mirrors catalogue type for charges (GST grouping)
  "description"       text NOT NULL,
  "amount"            numeric(14, 2) NOT NULL,
  "balance_after"     numeric(14, 2) NOT NULL,
  "lead_id"           varchar(50),
  "nbfc_id"           integer,
  "trigger_rule"      varchar(24),
  "posted_by"         uuid,
  "month"             varchar(7) NOT NULL,     -- 'YYYY-MM' for monthly statement grouping
  "created_at"        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "nbfc_wallet_ledger_tenant_month_idx"
  ON "nbfc_wallet_ledger" ("tenant_id", "month");
CREATE INDEX IF NOT EXISTS "nbfc_wallet_ledger_lead_idx"
  ON "nbfc_wallet_ledger" ("lead_id");

DO $do$ BEGIN
  ALTER TABLE "nbfc_wallet_ledger"
    ADD CONSTRAINT "nbfc_wallet_ledger_kind_check"
    CHECK ("kind" IN ('charge', 'manual_deduction', 'topup', 'adjustment'));
EXCEPTION WHEN duplicate_object THEN RAISE NOTICE 'skip: nbfc_wallet_ledger_kind_check exists';
END; $do$;

COMMENT ON TABLE "nbfc_wallets" IS
  'Addendum V0.2 §8.1 — NBFC prepaid wallet (Model 1). Empty wallet blocks new chargeable activity; manual top-up + auto-NACH recharge.';
COMMENT ON TABLE "nbfc_charge_catalogue" IS
  'Addendum V0.2 §8.2 — admin-maintained chargeable-item catalogue. tenant_id NULL = global default; non-null = per-NBFC override.';
COMMENT ON TABLE "nbfc_wallet_ledger" IS
  'Addendum V0.2 §8.2 — append-only wallet ledger. amount<0 debit, >0 credit; month groups the GST statement.';
