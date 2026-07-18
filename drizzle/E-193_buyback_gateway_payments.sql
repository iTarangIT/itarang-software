------------------------------------------------------------------------------
-- E-193: peakAmp Battery Buyback — online gateway money moves (RazorpayX
-- payouts to dealers, Razorpay Payment Links from vendors).
--
-- settlement_transactions stays exactly what E-187 made it: a settlement row
-- is a FACT (recorded == closed). This table holds the ATTEMPT — the in-flight
-- gateway transaction — and only a terminal SUCCESS mints a settlement row
-- (method='API'). A failed payout leaves no settlement; retry = a new row here.
--
-- buyback_gateway_transactions references buyback_deals (E-185) and
-- settlement_transactions (E-187), plus the buyback_leg / buyback_settle_direction
-- enum types those files declared. Those all land together, or not at all, per
-- env — prod currently has none of them (see drizzle/MIGRATION_CHECKLIST.md).
-- So the table + its indexes + its comment are ONE DO block guarded with
-- `EXCEPTION WHEN undefined_table OR undefined_object` (undefined_table for the
-- missing FK targets, undefined_object for the missing enum types), mirroring
-- E-191/E-192's defensiveness. It no-ops with a single NOTICE there instead of
-- erroring out.
--
-- `accounts.bank_beneficiary_name` is UNGUARDED: `accounts` is not a buyback
-- table and exists on every environment, including prod.
--
-- Additive + idempotent. Re-running this file is a no-op.
------------------------------------------------------------------------------

------------------------------------------------------------------------------
-- 1. ENUM TYPES — declared up front so no ALTER TYPE is ever needed (E-187
--    precedent). These do not depend on any buyback table, so they are created
--    unconditionally even on envs where buyback_deals doesn't exist yet.
------------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_gateway_kind') THEN
    CREATE TYPE buyback_gateway_kind AS ENUM ('PAYOUT', 'PAYMENT_LINK');
  END IF;

  -- In-flight: INITIATED (row committed, provider call may not have happened),
  -- PENDING (RazorpayX approval workflow), QUEUED (low balance), PROCESSING.
  -- Terminal success: PROCESSED (payout) / PAID (link) — the ONLY states that
  -- mint a settlement row. Terminal failure: FAILED / REJECTED / CANCELLED /
  -- EXPIRED. REVERSED is terminal-after-success (bank bounced it AFTER
  -- processed) — never auto-unwound, a human is alerted.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_gateway_status') THEN
    CREATE TYPE buyback_gateway_status AS ENUM
      ('INITIATED','PENDING','QUEUED','PROCESSING',
       'PROCESSED','PAID','FAILED','REJECTED','CANCELLED','EXPIRED','REVERSED');
  END IF;
END $$;

------------------------------------------------------------------------------
-- 2. BUYBACK_GATEWAY_TRANSACTIONS — the ATTEMPT, not the fact.
--
--    Guarded: depends on buyback_deals / settlement_transactions (E-185/E-187)
--    and the buyback_leg / buyback_settle_direction enum types they declared.
--    See header note.
------------------------------------------------------------------------------
DO $do$ BEGIN

  CREATE TABLE IF NOT EXISTS buyback_gateway_transactions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id        UUID NOT NULL REFERENCES buyback_deals(id) ON DELETE CASCADE,
    leg            buyback_leg NOT NULL,
    direction      buyback_settle_direction NOT NULL,
    kind           buyback_gateway_kind NOT NULL,
    provider       TEXT NOT NULL,                    -- 'RAZORPAYX' | 'RAZORPAY'
    amount         NUMERIC(14,2) NOT NULL,           -- rupees, server-derived from locks
    status         buyback_gateway_status NOT NULL DEFAULT 'INITIATED',
    provider_ref   TEXT,                             -- 'pout_...' / 'plink_...'
    payment_id     TEXT,                             -- 'pay_...' (link leg)
    utr            TEXT,
    short_url      TEXT,                             -- link leg only
    failure_reason TEXT,
    raw_payload    JSONB,                            -- last provider snapshot
    settlement_id  UUID REFERENCES settlement_transactions(id),  -- set on success
    initiated_by   UUID,                             -- the admin who clicked; audit + webhook actor
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT gateway_amount_positive CHECK (amount > 0)
  );

  -- Webhook correlation + the DB-level "same payout applied twice" guard.
  CREATE UNIQUE INDEX IF NOT EXISTS gateway_txn_provider_ref_unique
    ON buyback_gateway_transactions (provider_ref) WHERE provider_ref IS NOT NULL;

  -- THE race guard: at most ONE in-flight gateway transaction per (deal, leg).
  -- A double-clicked "Pay via RazorpayX" cannot create two payouts.
  CREATE UNIQUE INDEX IF NOT EXISTS gateway_txn_one_inflight_per_leg
    ON buyback_gateway_transactions (deal_id, leg)
    WHERE status IN ('INITIATED','PENDING','QUEUED','PROCESSING');

  CREATE INDEX IF NOT EXISTS gateway_txn_deal_idx
    ON buyback_gateway_transactions (deal_id);
  -- The poller's scan.
  CREATE INDEX IF NOT EXISTS gateway_txn_inflight_idx
    ON buyback_gateway_transactions (updated_at)
    WHERE status IN ('INITIATED','PENDING','QUEUED','PROCESSING');

  COMMENT ON TABLE buyback_gateway_transactions IS
    'E-193 — the ATTEMPT, not the fact. Holds an in-flight RazorpayX payout or Razorpay Payment Link; only a terminal SUCCESS (PROCESSED/PAID) mints a settlement_transactions row (method=''API''). A FAILED/REJECTED/CANCELLED/EXPIRED attempt leaves no settlement — retrying is a NEW row here, never an update of this one. REVERSED is terminal-AFTER-success (bank bounced an already-processed payout) and is never auto-unwound; a human is alerted. gateway_txn_one_inflight_per_leg is the race guard: a double-clicked "Pay via RazorpayX" cannot create two in-flight attempts for the same (deal, leg).';

EXCEPTION WHEN undefined_table OR undefined_object THEN
  RAISE NOTICE 'buyback_deals / settlement_transactions / buyback_leg / buyback_settle_direction do not exist here yet (E-185/E-187 not applied) — skipping E-193 buyback_gateway_transactions';
END; $do$;

------------------------------------------------------------------------------
-- 3. ACCOUNTS — RazorpayX fund_account.bank_account.name for a payout; falls
--    back to business_entity_name when null. UNGUARDED: `accounts` exists on
--    every environment, buyback tables or not.
------------------------------------------------------------------------------
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS bank_beneficiary_name TEXT;

COMMENT ON COLUMN accounts.bank_beneficiary_name IS
  'E-193 — RazorpayX fund_account.bank_account.name for a payout; falls back to business_entity_name when null.';
