------------------------------------------------------------------------------
-- E-187: peakAmp Battery Buyback — invoices, settlement, ledger (Sprint 2B).
--
-- Sprint 2A left the deal at PICKED_UP: the batteries are physically iTarang's,
-- a vendor has agreed, both POs are exchanged. This file moves the money:
--
--   PICKED_UP → INVOICE_RAISED → INVOICE_APPROVED → SETTLED → CLOSED
--
-- No ALTER TYPE: E-185 declared all 21 states up front.
-- Spec: docs/peakAmp/DEVELOPMENT_BRD.md §3, M12–M14.
--
-- FOUR INVARIANTS ENFORCED HERE, IN THE SCHEMA, NOT IN APP CODE:
--
--   · A MANUAL settlement without proof is IMPOSSIBLE. A CHECK constraint, not a
--     Zod rule. M13's AC ("manual settlement without proof rejected") is the one
--     that stops an unevidenced payout being recorded against a real deal, so it
--     is enforced where it cannot be bypassed by a script, a backfill, or a
--     future route that forgets.
--
--   · Every invoice is itemized per SKU. `invoices` carries NO amount column —
--     amounts live only on invoice_lines. This is what makes M12's AC possible at
--     all: "one edited line blocks approval EVEN IF THE TOTAL MATCHES". You cannot
--     compare line by line against a lump sum.
--
--   · At most ONE live invoice per (deal, leg) — a partial UNIQUE index that
--     ignores RETURNED rows. A returned invoice is not deleted or overwritten: it
--     stays, with its reason, and the dealer raises a fresh one. The history of
--     what was rejected and why is the point.
--
--   · One settlement per sub-transaction. UNIQUE on leg_sub_id ('TXN-1024-D'),
--     so a dealer cannot be paid out twice by a double-submit.
--
-- PAYOUT IS RECORDED, NEVER EXECUTED (BRD §10). Nothing here talks to a bank or
-- to Razorpay — which is inbound-collection-only in this codebase anyway
-- (createPaymentQr / e-mandate / virtual accounts). An admin pays the dealer out
-- of band and records it here, with proof. `method` already declares STATEMENT
-- and API so the reconcile and bank-API paths (U9, Sprint 3/5) need no DDL.
--
-- Additive + idempotent. Re-running this file is a no-op.
------------------------------------------------------------------------------

------------------------------------------------------------------------------
-- 1. ENUM TYPES
------------------------------------------------------------------------------
DO $$ BEGIN
  -- RAISED → APPROVED, or RAISED → RETURNED (and the dealer raises a new one).
  -- There is no "PAID" here: money lives on settlement_transactions, not on the
  -- invoice. An invoice is a claim; a settlement is a fact.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_invoice_status') THEN
    CREATE TYPE buyback_invoice_status AS ENUM ('RAISED', 'APPROVED', 'RETURNED');
  END IF;

  -- Who issued the document. The dealer invoices US (we approve it); we invoice
  -- the VENDOR. Two invoices per deal, facing opposite ways.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_invoice_party') THEN
    CREATE TYPE buyback_invoice_party AS ENUM ('DEALER', 'ITARANG');
  END IF;

  -- Build order per U9: MANUAL now, STATEMENT reconcile in Sprint 3, bank/Razorpay
  -- API later. Declared now so neither needs an ALTER TYPE.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_settle_method') THEN
    CREATE TYPE buyback_settle_method AS ENUM ('MANUAL', 'STATEMENT', 'API');
  END IF;

  -- OUT = money leaves iTarang (dealer payout). IN = money arrives (vendor receipt).
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_settle_direction') THEN
    CREATE TYPE buyback_settle_direction AS ENUM ('OUT', 'IN');
  END IF;
END $$;

------------------------------------------------------------------------------
-- 2. SEQUENCE — iTarang's OWN invoice series.
--
--    Only for the invoice WE issue to the vendor. The dealer's invoice number is
--    the DEALER's: it is their legal document on their own GST series, and
--    issuing a number on someone else's series is not a thing you may do. We
--    store what they tell us.
------------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS buyback_invoice_no_seq START WITH 5001;

------------------------------------------------------------------------------
-- 3. INVOICES (M12)
--
--    leg=DEALER, raised_by=DEALER   — they bill us; we approve or return it
--    leg=VENDOR, raised_by=ITARANG  — we bill the vendor; generated from locks
--
--    NO AMOUNT COLUMN. See invoice_lines.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id         UUID NOT NULL REFERENCES buyback_deals(id) ON DELETE CASCADE,
  leg             buyback_leg NOT NULL,
  raised_by_party buyback_invoice_party NOT NULL,
  -- The dealer's own number on their own series; or ours (INV-5001-V) on the
  -- vendor leg.
  number          TEXT NOT NULL,
  pdf_s3          TEXT,
  status          buyback_invoice_status NOT NULL DEFAULT 'RAISED',
  approved_by     UUID,
  approved_at     TIMESTAMPTZ,
  -- Why it was sent back. Kept forever — a returned invoice is history, not a
  -- mistake to be tidied away.
  returned_reason TEXT,
  returned_at     TIMESTAMPTZ,
  raised_by       UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one LIVE invoice per leg. A RETURNED one is excluded, so the dealer can
-- raise a fresh invoice after a rejection without us deleting the evidence of
-- what was wrong the first time.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_one_live_per_deal_leg
  ON invoices (deal_id, leg) WHERE status <> 'RETURNED';

CREATE INDEX IF NOT EXISTS invoices_deal_idx ON invoices (deal_id);

------------------------------------------------------------------------------
-- 4. INVOICE LINES (M12 / P5)
--
--    THE WHOLE POINT OF THIS TABLE: approval compares these rows, one at a time,
--    against deal_line_locks. "One edited line blocks approval even if the total
--    matches" is only expressible because the total is never stored — it is
--    derived from these rows, and each row is checked on its own.
--
--    `matched` is the recorded VERDICT of that comparison, so the approval screen
--    (and the audit log) can show exactly which line failed, months later.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice_lines (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_id        UUID NOT NULL REFERENCES buyback_lines(id) ON DELETE CASCADE,
  quantity       INTEGER NOT NULL,
  price_per_unit NUMERIC(12,2) NOT NULL,
  -- NULL until the invoice is checked; then TRUE/FALSE per line.
  matched        BOOLEAN,
  -- Chirag gate (BRD §10) — modelled, not yet ruled on. Same as purchase_order_lines.
  hsn_code       TEXT,
  taxable_value  NUMERIC(14,2),
  cgst           NUMERIC(12,2),
  sgst           NUMERIC(12,2),
  igst           NUMERIC(12,2),
  reverse_charge BOOLEAN,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS invoice_lines_invoice_line_unique
  ON invoice_lines (invoice_id, line_id);

------------------------------------------------------------------------------
-- 5. SETTLEMENT TRANSACTIONS (M13 / U9 / U10)
--
--    Two per deal, under one group:
--      TXN-1024-D  OUT  we pay the dealer
--      TXN-1024-V  IN   the vendor pays us
--    Both closed ⇒ SETTLED. The difference between them IS the realised margin,
--    which is what M14's reconciliation invariant checks against the locks.
--
--    THE CHECK CONSTRAINT IS THE AC. "Manual settlement without proof rejected"
--    (M13) is enforced by the database, so an unevidenced payout cannot be
--    recorded by any route, script or backfill — present or future. A payment
--    with no proof is not a payment, it is a claim.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settlement_transactions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id       UUID NOT NULL REFERENCES buyback_deals(id) ON DELETE CASCADE,
  -- 'TXN-1024' — the pair.
  group_txn_id  TEXT NOT NULL,
  -- 'TXN-1024-D' | 'TXN-1024-V' — the individual leg.
  leg_sub_id    TEXT NOT NULL,
  leg           buyback_leg NOT NULL,
  direction     buyback_settle_direction NOT NULL,
  method        buyback_settle_method NOT NULL DEFAULT 'MANUAL',
  txn_ref       TEXT,                       -- UTR / bank reference
  amount        NUMERIC(14,2) NOT NULL,
  txn_date      DATE NOT NULL,
  proof_s3      TEXT,
  note          TEXT,
  recorded_by   UUID,
  closed_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- M13 AC, at the only level that actually holds.
  CONSTRAINT settlement_manual_needs_proof
    CHECK (method <> 'MANUAL' OR (proof_s3 IS NOT NULL AND txn_ref IS NOT NULL)),
  CONSTRAINT settlement_amount_positive CHECK (amount > 0)
);

-- One settlement per sub-transaction: a double-submit cannot pay a dealer twice.
CREATE UNIQUE INDEX IF NOT EXISTS settlement_transactions_leg_sub_unique
  ON settlement_transactions (leg_sub_id);
CREATE INDEX IF NOT EXISTS settlement_transactions_deal_idx
  ON settlement_transactions (deal_id);
-- The ledger (M14) reads by date.
CREATE INDEX IF NOT EXISTS settlement_transactions_date_idx
  ON settlement_transactions (txn_date DESC);

------------------------------------------------------------------------------
-- 6. COMMENTS
------------------------------------------------------------------------------
COMMENT ON TABLE invoices IS
  'E-187 — two per deal, facing opposite ways: the dealer bills iTarang (we approve or return it), iTarang bills the vendor. INVARIANT: no amount column — amounts live on invoice_lines, which is what makes M12''s AC ("one edited line blocks approval even if the total matches") expressible at all. A RETURNED invoice is kept, with its reason; the partial unique index invoices_one_live_per_deal_leg lets a fresh one be raised without erasing it.';

COMMENT ON TABLE invoice_lines IS
  'E-187 — the per-SKU rows that approval compares, one at a time, against deal_line_locks. `matched` records the verdict per line so the failing line is still identifiable months later.';

COMMENT ON TABLE settlement_transactions IS
  'E-187 — TXN-{n}-D (OUT, dealer payout) + TXN-{n}-V (IN, vendor receipt). INVARIANT: settlement_manual_needs_proof makes an unevidenced MANUAL payout impossible at the DATABASE level (M13 AC) — not merely rejected by a route that a script could bypass. Payouts are RECORDED here, never executed (BRD §10).';

COMMENT ON COLUMN settlement_transactions.leg_sub_id IS
  'E-187 — UNIQUE. A double-submit cannot pay the same dealer twice.';
