-- E-160 — BRD Addendum V0.3.1 §16.4 (Vendor-Neutral WalletFundsProvider) +
-- §16.3 (Money-Handling Safeguards), "funds-in" half of the NBFC prepaid wallet.
--
-- E-137 built the draw-down half (wallet, catalogue, ledger). This adds the
-- operational handles for money actually moving IN:
--   • the per-NBFC iTarang Virtual Account (Smart Collect VA) display fields,
--   • the creditor-side auto-recharge mandate (iTarang as creditor) handles,
--   • a dedicated, idempotency-guaranteed inflow table so a re-delivered webhook
--     can never double-credit (§16.3 idempotent transaction handling).
--
-- Canonical balance still lives on nbfc_wallets.balance and is driven by the
-- append-only nbfc_wallet_ledger; these columns are provider correlation handles
-- + raw data only. Strictly additive + idempotent.

-- ── nbfc_wallets: provider + iTarang Virtual Account + auto-recharge mandate ──
ALTER TABLE "nbfc_wallets" ADD COLUMN IF NOT EXISTS "provider_name"           varchar(40);
ALTER TABLE "nbfc_wallets" ADD COLUMN IF NOT EXISTS "va_provider_account_id"  varchar(64);
ALTER TABLE "nbfc_wallets" ADD COLUMN IF NOT EXISTS "va_upi_vpa"              varchar(120);
ALTER TABLE "nbfc_wallets" ADD COLUMN IF NOT EXISTS "va_account_number"       varchar(40);
ALTER TABLE "nbfc_wallets" ADD COLUMN IF NOT EXISTS "va_ifsc"                 varchar(20);
ALTER TABLE "nbfc_wallets" ADD COLUMN IF NOT EXISTS "va_status"               varchar(24);
ALTER TABLE "nbfc_wallets" ADD COLUMN IF NOT EXISTS "auto_nach_customer_id"   varchar(64);
ALTER TABLE "nbfc_wallets" ADD COLUMN IF NOT EXISTS "auto_nach_token_id"      varchar(64);
ALTER TABLE "nbfc_wallets" ADD COLUMN IF NOT EXISTS "auto_nach_order_id"      varchar(64);
ALTER TABLE "nbfc_wallets" ADD COLUMN IF NOT EXISTS "auto_nach_status"        varchar(24) DEFAULT 'none';
ALTER TABLE "nbfc_wallets" ADD COLUMN IF NOT EXISTS "auto_nach_last_fired_at" timestamptz;

DO $do$ BEGIN
  ALTER TABLE "nbfc_wallets"
    ADD CONSTRAINT "nbfc_wallets_auto_nach_status_check"
    CHECK ("auto_nach_status" IS NULL
           OR "auto_nach_status" IN ('none', 'pending', 'registered', 'failed'));
EXCEPTION
  WHEN duplicate_object THEN RAISE NOTICE 'skip: nbfc_wallets_auto_nach_status_check exists';
  WHEN undefined_table  THEN RAISE NOTICE 'skip: nbfc_wallets missing';
END; $do$;

-- ── nbfc_wallet_ledger: provider correlation handle on top-up lines ──────────
ALTER TABLE "nbfc_wallet_ledger" ADD COLUMN IF NOT EXISTS "provider_event_id" varchar(120);

-- ── nbfc_wallet_inflows: §16.3 idempotency + audit ledger for money-in ───────
-- One row per provider inflow event (VA credit / recurring-debit settlement).
-- The UNIQUE (provider_name, provider_event_id) is the dedupe guarantee: the
-- credit path inserts ON CONFLICT DO NOTHING, so a re-delivered webhook is a
-- no-op. ledger_id links to the topup line actually posted (NULL until posted).
CREATE TABLE IF NOT EXISTS "nbfc_wallet_inflows" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"         uuid NOT NULL,
  "nbfc_id"           integer,
  "provider_name"     varchar(40) NOT NULL,
  "provider_event_id" varchar(120) NOT NULL,
  "amount"            numeric(14, 2) NOT NULL,
  "raw_status"        varchar(40),
  "ledger_id"         uuid,
  "raw_payload"       jsonb,
  "created_at"        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "nbfc_wallet_inflows_event_unique"
  ON "nbfc_wallet_inflows" ("provider_name", "provider_event_id");
CREATE INDEX IF NOT EXISTS "nbfc_wallet_inflows_tenant_idx"
  ON "nbfc_wallet_inflows" ("tenant_id");

COMMENT ON TABLE "nbfc_wallet_inflows" IS
  'Addendum V0.3.1 §16.3/§16.4 — idempotency + audit ledger for wallet money-in. UNIQUE(provider_name, provider_event_id) prevents double-credit on webhook re-delivery.';
COMMENT ON COLUMN "nbfc_wallets"."va_provider_account_id" IS
  'Provider virtual-account id (Smart Collect). Surfaced to the NBFC as the "iTarang Virtual Account" (§3.2 — no vendor name in NBFC UI).';
COMMENT ON COLUMN "nbfc_wallets"."auto_nach_token_id" IS
  'Registered recurring token for the iTarang Auto-Recharge Mandate (§16.4 creditor-side NACH).';
