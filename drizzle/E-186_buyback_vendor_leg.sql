------------------------------------------------------------------------------
-- E-186: peakAmp Battery Buyback — the vendor leg & fulfilment (Sprint 2A).
--
-- Sprint 1 (E-185) took a deal as far as MARGIN_SET: the dealer's per-SKU price
-- is accepted and the margin is locked. This file carries it to PICKED_UP:
--
--   MARGIN_SET → VENDOR_ROUTED → VENDOR_NEGOTIATING → VENDOR_AGREED
--              → PO_EXCHANGED → PICKUP_SCHEDULED → PICKED_UP
--
-- Money (invoices, settlement, ledger) is Sprint 2B and is NOT in this file.
-- No ALTER TYPE is needed for any of it: E-185 declared all 21 states up front.
--
-- Spec: docs/peakAmp/DEVELOPMENT_BRD.md §3, M09–M11 (+ a minimal M05 pass-through).
--
-- FOUR INVARIANTS ARE ENFORCED HERE, IN THE SCHEMA, NOT IN APP CODE:
--
--   · Every vendor ask/counter/agreement is itemized per SKU. vendor_threads
--     carries NO amount column — amounts live only on vendor_thread_lines. A
--     lump-sum vendor quote is not representable. (BRD P5. The design prototype
--     averages per-line amounts into one number; that bug cannot be ported.)
--
--   · At most ONE vendor may be AGREED per deal — a partial UNIQUE index. "First
--     AGREED wins, others auto-LOST" (M10) is therefore decided by the database,
--     not by a read-then-write race between two admins.
--
--   · deal_line_locks becomes FILL-ONCE rather than strictly immutable. BRD §3
--     puts vendor_price on the lock, but that value is unknowable until the
--     vendor agrees. A BEFORE UPDATE trigger permits exactly one write: setting
--     vendor_price from NULL. Every other column, including vendor_ask and the
--     margin, is frozen. This keeps "all documents and reports read from locks"
--     true without letting a lock drift.
--
--   · Purchase orders are impossible before VENDOR_AGREED (M11 AC). The state
--     machine gates the transition; UNIQUE (deal_id, leg) stops a duplicate PO.
--
-- Also extends buyback_notification_events for dispatch. Sprint 1 records events
-- and nothing reads them; Sprint 2A builds the consumer, so each event now
-- snapshots WHERE it is going (recipient_ref) and WHAT it carries
-- (attachment_s3_key) at emit time — the dispatcher never re-derives a
-- recipient, and the audit trail records where mail actually went.
--
-- Additive + idempotent. Re-running this file is a no-op.
------------------------------------------------------------------------------

------------------------------------------------------------------------------
-- 1. ENUM TYPES
------------------------------------------------------------------------------
DO $$ BEGIN
  -- A thread is one vendor's conversation about one deal. SENT → COUNTERED* →
  -- AGREED | LOST. Distinct from the DEAL status: a vendor going LOST does not
  -- move the deal.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_vendor_thread_status') THEN
    CREATE TYPE buyback_vendor_thread_status AS ENUM ('SENT', 'COUNTERED', 'AGREED', 'LOST');
  END IF;

  -- Who issued the PO. iTarang ISSUES one to the dealer (it is the buyer there)
  -- and RECEIVES one from the vendor (it is the seller there) — U7's
  -- "buyer initiates" rule, which is why direction is not derivable from leg
  -- alone and is stored.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_po_direction') THEN
    CREATE TYPE buyback_po_direction AS ENUM ('ISSUED', 'RECEIVED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_po_status') THEN
    CREATE TYPE buyback_po_status AS ENUM ('GENERATED', 'SENT', 'ACKNOWLEDGED');
  END IF;

  -- U11: a pickup may cover a whole order, one batch, or specific lines.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_pickup_scope') THEN
    CREATE TYPE buyback_pickup_scope AS ENUM ('ORDER', 'BATCH', 'LINE');
  END IF;
END $$;

------------------------------------------------------------------------------
-- 2. SEQUENCES — human-facing document numbers.
--
--    A sequence, never max()+1: two concurrent PO generations must not collide,
--    and a gap is harmless where a duplicate is not. Same pattern as E-185's
--    buyback_request_no_seq (BB-1024…).
------------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS buyback_po_no_seq START WITH 5001;

------------------------------------------------------------------------------
-- 3. SCRAP VENDORS (M09 / M18)
--
--    A vendor IS an `accounts` row (the existing entity + KYC store) plus a
--    business_entity_roles row with role='SCRAP_VENDOR' — E-185 already laid
--    that layer down. This table holds only what is vendor-SPECIFIC: what they
--    buy, where they collect, how they pay.
--
--    Sprint 2A creates vendors with role status ACTIVE directly. Sprint 4 (M18/
--    M19) adds the agreement + eSign gate; because routing filters on
--    business_entity_roles.status = 'ACTIVE', that sprint tightens what ACTIVE
--    *means* without touching this table or the routing query.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scrap_vendors (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id      VARCHAR(255) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  categories     JSONB NOT NULL DEFAULT '[]'::jsonb,   -- e.g. ["LI_ION","LFP"]
  regions        TEXT[] NOT NULL DEFAULT '{}',         -- states/cities they collect from
  payment_terms  TEXT,                                 -- free text, e.g. "Net 15"
  credit_limit   NUMERIC(14,2),
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One vendor profile per entity.
CREATE UNIQUE INDEX IF NOT EXISTS scrap_vendors_entity_unique ON scrap_vendors (entity_id);
CREATE INDEX IF NOT EXISTS scrap_vendors_active_idx ON scrap_vendors (active) WHERE active;

------------------------------------------------------------------------------
-- 4. VENDOR THREADS (M09/M10)
--
--    One row per (deal, vendor) — the quotation we emailed and everything that
--    came back. NO AMOUNT COLUMN: see vendor_thread_lines.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendor_threads (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id          UUID NOT NULL REFERENCES buyback_deals(id) ON DELETE CASCADE,
  vendor_id        UUID NOT NULL REFERENCES scrap_vendors(id) ON DELETE RESTRICT,
  status           buyback_vendor_thread_status NOT NULL DEFAULT 'SENT',
  -- The masked quotation actually sent (M09 AC: no dealer identity in it).
  quotation_pdf_s3 TEXT,
  quotation_no     TEXT,
  -- Proof of dispatch, from the mail provider. U6 wants this logged.
  email_message_id TEXT,
  sent_at          TIMESTAMPTZ,
  responded_at     TIMESTAMPTZ,
  closed_at        TIMESTAMPTZ,
  close_reason     TEXT,                -- why LOST — e.g. 'another vendor agreed'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A deal is routed to a given vendor once.
CREATE UNIQUE INDEX IF NOT EXISTS vendor_threads_deal_vendor_unique
  ON vendor_threads (deal_id, vendor_id);

-- INVARIANT: at most one AGREED vendor per deal. This is what makes "first
-- AGREED wins" true even if two admins record agreements for different vendors
-- at the same instant — the second transaction fails here rather than silently
-- creating a deal that owes its batteries to two buyers.
CREATE UNIQUE INDEX IF NOT EXISTS vendor_threads_one_agreed_per_deal
  ON vendor_threads (deal_id) WHERE status = 'AGREED';

CREATE INDEX IF NOT EXISTS vendor_threads_deal_idx ON vendor_threads (deal_id);

------------------------------------------------------------------------------
-- 5. VENDOR THREAD LINES (P5)
--
--    The itemization. ask_price is what we asked (= the lock's vendor_ask at
--    routing time), counter_price is the vendor's latest per-SKU counter,
--    agreed_price is what was finally struck.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendor_thread_lines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id     UUID NOT NULL REFERENCES vendor_threads(id) ON DELETE CASCADE,
  line_id       UUID NOT NULL REFERENCES buyback_lines(id) ON DELETE CASCADE,
  ask_price     NUMERIC(12,2) NOT NULL,   -- ₹/unit we asked for
  counter_price NUMERIC(12,2),            -- ₹/unit they came back with
  agreed_price  NUMERIC(12,2),            -- ₹/unit finally agreed
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_thread_lines_thread_line_unique
  ON vendor_thread_lines (thread_id, line_id);

------------------------------------------------------------------------------
-- 6. PURCHASE ORDERS (M11)
--
--    Two per deal, one per leg:
--      leg=DEALER, direction=ISSUED   — iTarang → dealer, generated from locks
--      leg=VENDOR, direction=RECEIVED — vendor → iTarang, recorded by an admin
--    When both exist the deal moves to PO_EXCHANGED (see the state machine).
--
--    AC: "PO impossible before VENDOR_AGREED" — gated by the state machine, and
--    UNIQUE (deal_id, leg) prevents a second PO on either side.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_orders (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id               UUID NOT NULL REFERENCES buyback_deals(id) ON DELETE CASCADE,
  leg                   buyback_leg NOT NULL,
  direction             buyback_po_direction NOT NULL,
  number                TEXT NOT NULL,          -- PO-5001-D / the vendor's own number
  pdf_s3                TEXT,
  status                buyback_po_status NOT NULL DEFAULT 'GENERATED',
  counterparty_entity_id VARCHAR(255) REFERENCES accounts(id),
  issued_at             TIMESTAMPTZ,
  acknowledged_at       TIMESTAMPTZ,
  created_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_deal_leg_unique
  ON purchase_orders (deal_id, leg);
CREATE INDEX IF NOT EXISTS purchase_orders_deal_idx ON purchase_orders (deal_id);

------------------------------------------------------------------------------
-- 7. PURCHASE ORDER LINES
--
--    Itemized, like everything else. Prices are copied from deal_line_locks at
--    generation time so a later lock generation cannot retro-change a PO that
--    has already gone out.
--
--    TAX COLUMNS ARE DELIBERATELY NULLABLE AND UNPOPULATED. GST/HSN/reverse-
--    charge is an open item (BRD §10) that gates the first live deal and is
--    Chirag's call, not ours. The columns exist now so that ruling becomes a
--    data change, not a migration; documents render tax-exclusive with a
--    "tax treatment pending" note until then.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id          UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_id        UUID NOT NULL REFERENCES buyback_lines(id) ON DELETE CASCADE,
  quantity       INTEGER NOT NULL,
  price_per_unit NUMERIC(12,2) NOT NULL,
  -- Chirag gate (BRD §10) — modelled, not yet ruled on.
  hsn_code       TEXT,
  taxable_value  NUMERIC(14,2),
  cgst           NUMERIC(12,2),
  sgst           NUMERIC(12,2),
  igst           NUMERIC(12,2),
  reverse_charge BOOLEAN,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_order_lines_po_line_unique
  ON purchase_order_lines (po_id, line_id);

------------------------------------------------------------------------------
-- 8. PICKUPS (M05 — minimal pass-through in Sprint 2A)
--
--    The FULL BRD shape lands now, but Sprint 2A only writes scheduled_at,
--    address, contact and completed_at — enough for the deal to legitimately
--    reach PICKED_UP instead of teleporting past two states it never entered.
--
--    The BWM 2022 compliance fields (e-way bill, weighbridge slip, actual
--    counts, variance flag, dealer acknowledgement) are declared here and filled
--    by Sprint 3's M05, which therefore needs no DDL of its own.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pickups (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id             UUID NOT NULL REFERENCES buyback_deals(id) ON DELETE CASCADE,
  batch_id            UUID REFERENCES buyback_batches(id) ON DELETE CASCADE,
  scope               buyback_pickup_scope NOT NULL DEFAULT 'BATCH',
  scheduled_at        TIMESTAMPTZ,
  address             TEXT,
  contact_name        TEXT,
  contact_phone       VARCHAR(20),
  -- Sprint 3 (M05 / BWM 2022) — declared, not yet populated.
  eway_bill_no        TEXT,
  weighbridge_slip_s3 TEXT,
  actual_counts       JSONB,
  variance_flag       BOOLEAN NOT NULL DEFAULT FALSE,
  dealer_ack_at       TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pickups_deal_idx ON pickups (deal_id);

------------------------------------------------------------------------------
-- 9. NOTIFICATION DISPATCH (M20 — the consumer Sprint 1 never built)
--
--    E-185 records events as PENDING and nothing drains them. Sprint 2A adds an
--    in-process dispatcher (BullMQ is dead code in this repo — no worker is
--    deployed — and Vercel crons do not fire on the pm2 VPS).
--
--    recipient_ref and attachment_s3_key are SNAPSHOTTED at emit time. The
--    dispatcher must never re-derive who to email: a vendor's address could be
--    edited between the transition and the send, and the audit trail must say
--    where the mail actually went, not where it would go if sent today.
------------------------------------------------------------------------------
ALTER TABLE buyback_notification_events
  ADD COLUMN IF NOT EXISTS attempts          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS recipient_ref     TEXT,   -- email / phone / user id, resolved at emit
  ADD COLUMN IF NOT EXISTS attachment_s3_key TEXT;   -- e.g. the quotation PDF

-- The dispatcher's claim query: oldest due PENDING first.
CREATE INDEX IF NOT EXISTS buyback_notification_events_due_idx
  ON buyback_notification_events (next_attempt_at)
  WHERE delivery_status = 'PENDING';

------------------------------------------------------------------------------
-- 10. deal_line_locks — FILL-ONCE (the one deliberate relaxation)
--
--     E-185 wrote locks once, at MARGIN_SET, and never updated them. But BRD §3
--     puts vendor_price on the lock, and that number does not exist until a
--     vendor agrees — so strict immutability and the BRD are in direct conflict.
--
--     Resolution: permit EXACTLY ONE update — setting vendor_price from NULL.
--     Everything else (dealer_price, margin_value, margin_mode, vendor_ask, the
--     offer_version this generation belongs to) is frozen. A second write to
--     vendor_price is refused. So a lock still cannot drift, reports still read
--     one row, and the margin a dashboard shows is the margin that was struck.
--
--     UPDATE only — DELETE is left alone so the ON DELETE CASCADE from
--     buyback_deals still works.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION deal_line_locks_fill_once()
RETURNS trigger AS $fn$
BEGIN
  IF NEW.id            IS DISTINCT FROM OLD.id
  OR NEW.deal_id       IS DISTINCT FROM OLD.deal_id
  OR NEW.line_id       IS DISTINCT FROM OLD.line_id
  OR NEW.offer_version IS DISTINCT FROM OLD.offer_version
  OR NEW.dealer_price  IS DISTINCT FROM OLD.dealer_price
  OR NEW.margin_value  IS DISTINCT FROM OLD.margin_value
  OR NEW.margin_mode   IS DISTINCT FROM OLD.margin_mode
  OR NEW.vendor_ask    IS DISTINCT FROM OLD.vendor_ask
  OR NEW.locked_by     IS DISTINCT FROM OLD.locked_by
  OR NEW.created_at    IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'deal_line_locks is immutable (E-186): only vendor_price may be written, and only once';
  END IF;

  IF OLD.vendor_price IS NOT NULL
     AND NEW.vendor_price IS DISTINCT FROM OLD.vendor_price THEN
    RAISE EXCEPTION
      'deal_line_locks.vendor_price is fill-once (E-186): already set to %', OLD.vendor_price;
  END IF;

  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS deal_line_locks_fill_once_guard ON deal_line_locks;
CREATE TRIGGER deal_line_locks_fill_once_guard
  BEFORE UPDATE ON deal_line_locks
  FOR EACH ROW EXECUTE FUNCTION deal_line_locks_fill_once();

------------------------------------------------------------------------------
-- 11. COMMENTS — the invariants, recorded where the next engineer will find them.
------------------------------------------------------------------------------
COMMENT ON TABLE vendor_threads IS
  'E-186 — one vendor''s conversation about one deal. INVARIANT: carries NO amount column; every ask/counter/agreement is itemized on vendor_thread_lines (BRD P5). INVARIANT: the partial unique index vendor_threads_one_agreed_per_deal permits at most one AGREED vendor per deal — that is what makes M10''s "first AGREED wins, others auto-LOST" atomic rather than a race.';

COMMENT ON TABLE vendor_thread_lines IS
  'E-186 — the per-SKU itemization of a vendor thread. A lump-sum vendor quote is deliberately unrepresentable.';

COMMENT ON TABLE purchase_orders IS
  'E-186 — two per deal: leg=DEALER/direction=ISSUED (iTarang → dealer, generated from deal_line_locks) and leg=VENDOR/direction=RECEIVED (vendor → iTarang, recorded). Both present ⇒ PO_EXCHANGED. Impossible before VENDOR_AGREED (M11 AC).';

COMMENT ON TABLE purchase_order_lines IS
  'E-186 — prices copied from deal_line_locks at generation, so a later lock generation cannot retro-change a PO already sent. Tax columns are modelled but unpopulated: GST/HSN/reverse-charge is an open item (BRD §10) gating the first live deal.';

COMMENT ON TABLE pickups IS
  'E-186 — full BRD/M05 shape, but Sprint 2A only writes schedule/contact/completion. The BWM 2022 fields (eway_bill_no, weighbridge_slip_s3, actual_counts, variance_flag, dealer_ack_at) are declared so Sprint 3 needs no DDL.';

COMMENT ON COLUMN deal_line_locks.vendor_price IS
  'E-186 — FILL-ONCE. Written from NULL exactly once, when a vendor agrees; the deal_line_locks_fill_once_guard trigger refuses a second write and refuses any change to the other columns.';

COMMENT ON COLUMN buyback_notification_events.recipient_ref IS
  'E-186 — the recipient address SNAPSHOTTED at emit time. The dispatcher never re-derives it: the audit trail must record where the message actually went, not where it would go if sent today.';
