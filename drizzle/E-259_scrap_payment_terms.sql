-- ===========================================================================
-- E-259 — Scrap payment terms: WHEN iTarang pays for a scrap consignment.
--
-- WHY
--   E-258 made every scrap purchase settle the same way: a rate is agreed and
--   admin pays, with nothing recorded about whether the batteries had actually
--   arrived. That is one commercial term applied to every counterparty, and it
--   is the wrong one for most of them — iTarang pays a new or unproven NBFC
--   only after the lot lands, and pays a trusted one up front so the batteries
--   move faster.
--
-- WHAT
--   1. `nbfc_scrap_payment_settings` — one row per NBFC tenant, holding that
--      term. 'pre_lot' = pay before the batteries reach iTarang; 'post_lot' =
--      pay once they have. An NBFC with no row uses the safer default,
--      'post_lot', which is why the column is NOT backfilled: absence means
--      "nobody has decided", and reading it as post_lot is deliberate.
--   2. `scrap_consignments.received_at` / `received_by` — the arrival that
--      'post_lot' is waiting on. Without them the term is unenforceable: there
--      was no moment in the data at which the batteries became iTarang's.
--
-- Strictly additive. No DML, no backfill. Re-running is a no-op.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The per-NBFC term
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nbfc_scrap_payment_settings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  -- pre_lot | post_lot. A varchar + CHECK rather than an enum: the vocabulary
  -- lives in TypeScript beside the rule that reads it (see
  -- src/lib/nbfc/scrap/payment-settings.ts), and adding a third term later
  -- must not need an ALTER TYPE on a shared database.
  payment_timing  varchar(16) NOT NULL DEFAULT 'post_lot',
  -- Free text the admin can leave for whoever pays later ("agreed with their
  -- ops head", "until the first three lots clear").
  note            text,
  updated_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One term per NBFC. The upsert in setScrapPaymentTiming() targets this.
CREATE UNIQUE INDEX IF NOT EXISTS nbfc_scrap_payment_settings_tenant_uidx
  ON nbfc_scrap_payment_settings (tenant_id);

DO $do$ BEGIN
  ALTER TABLE nbfc_scrap_payment_settings
    ADD CONSTRAINT nbfc_scrap_payment_settings_timing_chk
    CHECK (payment_timing IN ('pre_lot', 'post_lot'));
EXCEPTION
  WHEN duplicate_object THEN RAISE NOTICE 'timing check already present';
  WHEN undefined_table THEN RAISE NOTICE 'skip — table absent';
END; $do$;

-- ---------------------------------------------------------------------------
-- 2. The arrival that 'post_lot' waits on
-- ---------------------------------------------------------------------------
-- Recorded by an admin when the batteries physically reach iTarang. Under
-- 'post_lot' this is a hard gate on the payout; under 'pre_lot' it is still
-- written, because "paid on the 3rd, arrived on the 11th" is the pair of dates
-- anyone reconciling a scrap purchase needs.
ALTER TABLE scrap_consignments
  ADD COLUMN IF NOT EXISTS received_at timestamptz;
ALTER TABLE scrap_consignments
  ADD COLUMN IF NOT EXISTS received_by uuid;

-- ---------------------------------------------------------------------------
-- Self-documentation
-- ---------------------------------------------------------------------------
COMMENT ON TABLE nbfc_scrap_payment_settings IS
  'E-259: per-NBFC scrap payment term. payment_timing pre_lot = iTarang pays before the batteries arrive; post_lot = only after they are marked received. No row for a tenant means post_lot.';
COMMENT ON COLUMN nbfc_scrap_payment_settings.payment_timing IS
  'pre_lot | post_lot. Read by assertPayable() in src/lib/nbfc/scrap/payment.ts.';
COMMENT ON COLUMN scrap_consignments.received_at IS
  'E-259: when the scrap batteries physically reached iTarang. Under a post_lot term the payout is blocked until this is set.';
COMMENT ON COLUMN scrap_consignments.received_by IS
  'E-259: the admin who recorded the arrival.';
