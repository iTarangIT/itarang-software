-- =============================================================================
-- E-270 — Refurbishment LOTS: the NBFC ⇄ iTarang workshop loop, digitised
-- =============================================================================
-- Until now refurbishment lived only in the NBFC portal: the NBFC raised one
-- job per battery and then pressed "Start work" / "Mark returned" itself, on
-- behalf of a workshop it does not run. The real process — NBFC ships a lot of
-- batteries, iTarang repairs them, ships them back — happened off-system.
--
-- This migration adds the two things the loop needs and nothing else:
--
--   refurbishment_lots        one row per batch the NBFC sends. Carries the
--                             negotiation (timeline + estimate, rounds) and
--                             both physical legs (out to the workshop, back to
--                             the NBFC) with transport details and receipts.
--   refurbishment_lot_events  append-only thread: who did what, when, with
--                             the payload of that move (proposal snapshot,
--                             docket, per-battery receipt). The header row is
--                             overwritten with every move; this is the history.
--
-- The per-battery item is NOT a new table. refurbishment_jobs already is one
-- row per battery with checklist / accessories / estimated vs actual cost, so
-- a job gains a `lot_id` and becomes the lot item. A job with lot_id IS NULL
-- keeps behaving exactly as E-233 shipped it.
--
-- Additive and idempotent. Safe to re-run. Same conventions as E-258 (status
-- vocabulary in TypeScript, no CHECK, no pgEnum).
--
-- Vocabulary (src/lib/nbfc/recovery/refurbishment-lot-status.ts):
--   lot.status   requested | proposed | countered | agreed | in_transit_out |
--                received | in_progress | ready | in_transit_return |
--                completed | cancelled
--   job.status   requested | declined | in_progress | ready | returned | cancelled
--                (E-233 had requested | in_progress | returned | cancelled)
-- =============================================================================

CREATE TABLE IF NOT EXISTS refurbishment_lots (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL,
  ref_code                    varchar(24) NOT NULL,
  status                      varchar(24) NOT NULL DEFAULT 'requested',
  battery_count               integer NOT NULL DEFAULT 0,
  note                        text,

  -- Negotiation: the CURRENT proposal. Every round is also written to
  -- refurbishment_lot_events with the full snapshot in payload.
  current_round               integer NOT NULL DEFAULT 0,
  last_party                  varchar(8),
  expected_receipt_date       date,
  expected_return_date        date,
  estimated_labour_total      numeric(14,2),
  estimated_accessories_total numeric(14,2),
  estimated_total             numeric(14,2),
  proposal_note               text,
  agreed_at                   timestamptz,
  agreed_by                   uuid,

  -- Leg 1: NBFC -> workshop.
  out_carrier                 varchar(120),
  out_vehicle_no              varchar(32),
  out_docket_no               varchar(64),
  out_dispatched_on           date,
  out_dispatch_note           text,
  out_photo_urls              text[] NOT NULL DEFAULT '{}',
  out_dispatched_at           timestamptz,
  out_dispatched_by           uuid,
  out_received_at             timestamptz,
  out_received_by             uuid,
  out_receipt_note            text,
  out_receipt_photo_urls      text[] NOT NULL DEFAULT '{}',
  out_has_mismatch            boolean NOT NULL DEFAULT false,

  -- Leg 2: workshop -> NBFC.
  ret_carrier                 varchar(120),
  ret_vehicle_no              varchar(32),
  ret_docket_no               varchar(64),
  ret_dispatched_on           date,
  ret_dispatch_note           text,
  ret_photo_urls              text[] NOT NULL DEFAULT '{}',
  ret_dispatched_at           timestamptz,
  ret_dispatched_by           uuid,
  ret_received_at             timestamptz,
  ret_received_by             uuid,
  ret_receipt_note            text,
  ret_receipt_photo_urls      text[] NOT NULL DEFAULT '{}',
  ret_has_mismatch            boolean NOT NULL DEFAULT false,

  work_started_at             timestamptz,
  completed_at                timestamptz,
  cancelled_at                timestamptz,
  cancelled_by                uuid,
  cancelled_by_party          varchar(8),
  cancel_reason               text,

  created_by                  uuid,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS refurbishment_lots_ref_uidx
  ON refurbishment_lots (ref_code);
CREATE INDEX IF NOT EXISTS refurbishment_lots_tenant_idx
  ON refurbishment_lots (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS refurbishment_lots_status_idx
  ON refurbishment_lots (status, created_at DESC);

COMMENT ON TABLE refurbishment_lots IS
  'E-270: one batch of recovered batteries the NBFC sends to the iTarang '
  'workshop. Carries the timeline/estimate negotiation and both physical legs. '
  'The per-battery items are refurbishment_jobs rows with lot_id set.';
COMMENT ON COLUMN refurbishment_lots.status IS
  'E-270: requested | proposed | countered | agreed | in_transit_out | received | '
  'in_progress | ready | in_transit_return | completed | cancelled. No CHECK — '
  'vocabulary lives in src/lib/nbfc/recovery/refurbishment-lot-status.ts.';
COMMENT ON COLUMN refurbishment_lots.last_party IS
  'E-270: nbfc | admin — who moved last; the other side owes the next move.';
COMMENT ON COLUMN refurbishment_lots.out_has_mismatch IS
  'E-270: TRUE when the workshop receipt marked any battery damaged or missing.';

-- ---------------------------------------------------------------------------
-- The thread
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refurbishment_lot_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id      uuid NOT NULL REFERENCES refurbishment_lots(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL,
  seq         integer NOT NULL,
  party       varchar(8) NOT NULL,
  kind        varchar(24) NOT NULL,
  message     text,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS refurbishment_lot_events_seq_uidx
  ON refurbishment_lot_events (lot_id, seq);
CREATE INDEX IF NOT EXISTS refurbishment_lot_events_lot_idx
  ON refurbishment_lot_events (lot_id, created_at);

COMMENT ON TABLE refurbishment_lot_events IS
  'E-270: append-only timeline of a refurbishment lot. party nbfc|admin|system; '
  'kind requested | item_declined | proposed | countered | accepted | cancelled | '
  'dispatched_out | received_out | work_started | item_ready | dispatched_return | '
  'received_return | message. payload carries the snapshot of that move. '
  'The unique (lot_id, seq) is the concurrency guard: seq is always max+1.';

-- ---------------------------------------------------------------------------
-- refurbishment_jobs becomes the lot item
-- ---------------------------------------------------------------------------
ALTER TABLE refurbishment_jobs
  ADD COLUMN IF NOT EXISTS lot_id                  uuid,
  ADD COLUMN IF NOT EXISTS decline_reason          text,
  ADD COLUMN IF NOT EXISTS decided_at              timestamptz,
  ADD COLUMN IF NOT EXISTS decided_by              uuid,
  ADD COLUMN IF NOT EXISTS out_received_condition  varchar(16),
  ADD COLUMN IF NOT EXISTS out_received_note       text,
  ADD COLUMN IF NOT EXISTS out_received_photo_urls text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ready_at                timestamptz,
  ADD COLUMN IF NOT EXISTS ret_received_condition  varchar(16),
  ADD COLUMN IF NOT EXISTS ret_received_note       text,
  ADD COLUMN IF NOT EXISTS ret_received_photo_urls text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS ret_received_at         timestamptz;

CREATE INDEX IF NOT EXISTS refurbishment_jobs_lot_idx
  ON refurbishment_jobs (lot_id);

COMMENT ON COLUMN refurbishment_jobs.lot_id IS
  'E-270: the refurbishment_lots row this job travels in. NULL = a legacy '
  'single job raised before lots existed; behaves exactly as E-233.';
COMMENT ON COLUMN refurbishment_jobs.out_received_condition IS
  'E-270: received | damaged | missing — what the workshop found on arrival.';
COMMENT ON COLUMN refurbishment_jobs.ret_received_condition IS
  'E-270: received | damaged | missing — what the NBFC found on return.';

-- The E-233 "one open job per battery" index must now also count `ready`: a
-- repaired battery sitting at the workshop waiting for the return truck is
-- still occupying its slot. Recreated rather than altered — Postgres has no
-- ALTER INDEX ... WHERE. Both statements are idempotent.
DROP INDEX IF EXISTS refurbishment_jobs_one_open_per_battery;
CREATE UNIQUE INDEX IF NOT EXISTS refurbishment_jobs_one_open_per_battery
  ON refurbishment_jobs (battery_id)
  WHERE status IN ('requested', 'in_progress', 'ready');

COMMENT ON COLUMN refurbishment_jobs.status IS
  'E-233/E-270: requested | declined | in_progress | ready | returned | cancelled. '
  'No CHECK — vocabulary is enforced in src/lib/nbfc/recovery/refurbishment.ts.';
