-- =============================================================================
-- E-271 — Refurbishment lots: pickup / e-way bill / custody, advance & balance,
--         quote approval + revision. Completes the E-270 state engine.
-- =============================================================================
-- E-270 built the conversation and the two trucks. Review raised nine gaps:
--
--   1 resubmit after decline      → last_decline_reason surfaced (no schema)
--   2 how is the cost approved    → quote_approved_* frozen on NBFC accept;
--                                   revision round if actuals exceed it
--   3 advance                     → advance_pct / amount / status + payment ref
--   4 where is the battery        → custody derived from status + the pickup /
--                                   delivery timestamps this migration adds
--   5 NBFC approves the quote     → same as 2
--   6 how batteries are picked up → pickup_mode, scheduled_pickup_date,
--                                   e-way bill no + upload on BOTH legs
--   7 picked up / in transit      → out_picked_up_at (iTarang pickup) or
--                                   out_dispatched_at (NBFC ships)
--   8 delivered to workshop       → out_delivered_at (arrived, before receipt)
--   9 missing states              → see refurbishment-lot-status.ts
--
-- Additive and idempotent. Vocabulary lives in TypeScript (no CHECK).
--
-- Lot status vocabulary after this migration:
--   requested | proposed | countered | agreed | awaiting_advance | advance_paid |
--   pickup_scheduled | in_transit_out | delivered | received | in_progress |
--   revision_pending | ready | in_transit_return | delivered_back |
--   balance_due | settled | cancelled
--
-- Money columns follow the E-252 auction_settlements shape (provider / ref /
-- paid_at) — one block per leg (advance, balance). Money flows NBFC → iTarang,
-- so this is Razorpay CHECKOUT (collect), never RazorpayX (payout).
-- =============================================================================

ALTER TABLE refurbishment_lots
  -- 6/7/8: how the batteries move
  ADD COLUMN IF NOT EXISTS pickup_mode            varchar(16) NOT NULL DEFAULT 'nbfc_ships', -- nbfc_ships | itarang_pickup
  ADD COLUMN IF NOT EXISTS pickup_address         text,
  ADD COLUMN IF NOT EXISTS workshop_address       text,
  ADD COLUMN IF NOT EXISTS scheduled_pickup_date  date,
  ADD COLUMN IF NOT EXISTS out_eway_bill_no       varchar(32),
  ADD COLUMN IF NOT EXISTS out_eway_bill_url      text,
  ADD COLUMN IF NOT EXISTS out_picked_up_at       timestamptz,
  ADD COLUMN IF NOT EXISTS out_picked_up_by       uuid,
  ADD COLUMN IF NOT EXISTS out_delivered_at       timestamptz,
  ADD COLUMN IF NOT EXISTS out_delivered_by       uuid,
  ADD COLUMN IF NOT EXISTS ret_eway_bill_no       varchar(32),
  ADD COLUMN IF NOT EXISTS ret_eway_bill_url      text,
  ADD COLUMN IF NOT EXISTS ret_delivered_at       timestamptz,
  ADD COLUMN IF NOT EXISTS ret_delivered_by       uuid,
  -- 2/5: the quote the NBFC approved, frozen at accept; revision round
  ADD COLUMN IF NOT EXISTS quote_approved_total   numeric(14,2),
  ADD COLUMN IF NOT EXISTS quote_approved_at      timestamptz,
  ADD COLUMN IF NOT EXISTS quote_approved_by      uuid,
  ADD COLUMN IF NOT EXISTS revised_total          numeric(14,2),
  ADD COLUMN IF NOT EXISTS revision_note          text,
  ADD COLUMN IF NOT EXISTS revision_round         integer NOT NULL DEFAULT 0,
  -- 3: advance (NBFC -> iTarang, before the batteries move)
  ADD COLUMN IF NOT EXISTS advance_pct            numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS advance_amount         numeric(14,2),
  ADD COLUMN IF NOT EXISTS advance_status         varchar(16) NOT NULL DEFAULT 'not_required', -- not_required | pending | recorded | confirmed
  ADD COLUMN IF NOT EXISTS advance_provider       varchar(16),   -- razorpay | offline
  ADD COLUMN IF NOT EXISTS advance_order_id       varchar(64),
  ADD COLUMN IF NOT EXISTS advance_payment_id     varchar(64),
  ADD COLUMN IF NOT EXISTS advance_reference      varchar(120),
  ADD COLUMN IF NOT EXISTS advance_recorded_at    timestamptz,
  ADD COLUMN IF NOT EXISTS advance_confirmed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS advance_confirmed_by   uuid,
  -- 3: balance (final_total - advance, raised when the NBFC signs for the return)
  ADD COLUMN IF NOT EXISTS final_total            numeric(14,2),
  ADD COLUMN IF NOT EXISTS balance_amount         numeric(14,2),
  ADD COLUMN IF NOT EXISTS balance_status         varchar(16) NOT NULL DEFAULT 'not_due',      -- not_due | pending | recorded | confirmed
  ADD COLUMN IF NOT EXISTS balance_provider       varchar(16),
  ADD COLUMN IF NOT EXISTS balance_order_id       varchar(64),
  ADD COLUMN IF NOT EXISTS balance_payment_id     varchar(64),
  ADD COLUMN IF NOT EXISTS balance_reference      varchar(120),
  ADD COLUMN IF NOT EXISTS balance_recorded_at    timestamptz,
  ADD COLUMN IF NOT EXISTS balance_confirmed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS balance_confirmed_by   uuid,
  ADD COLUMN IF NOT EXISTS settled_at             timestamptz;

COMMENT ON COLUMN refurbishment_lots.pickup_mode IS
  'E-271: nbfc_ships (NBFC books transport, records dispatch) | itarang_pickup '
  '(iTarang collects on scheduled_pickup_date, its agent records the pickup).';
COMMENT ON COLUMN refurbishment_lots.quote_approved_total IS
  'E-271: the estimate the NBFC approved by accepting the proposal. The lot '
  'cannot reach ready while actual work exceeds it — admin must send a revision '
  'and the NBFC must approve it.';
COMMENT ON COLUMN refurbishment_lots.advance_status IS
  'E-271: not_required | pending (NBFC owes it) | recorded (NBFC entered a '
  'reference / paid online) | confirmed (iTarang saw the money).';
COMMENT ON COLUMN refurbishment_lots.balance_status IS
  'E-271: not_due | pending | recorded | confirmed — final_total minus advance, '
  'raised when the NBFC signs for the returned batteries.';

-- Existing E-270 rows: a lot that reached `completed` had no money leg; it is settled.
UPDATE refurbishment_lots
   SET status = 'settled', settled_at = COALESCE(completed_at, now())
 WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS refurbishment_lots_money_open_idx
  ON refurbishment_lots (advance_status, balance_status)
  WHERE advance_status IN ('pending', 'recorded') OR balance_status IN ('pending', 'recorded');
