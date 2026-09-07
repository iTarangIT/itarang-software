-- E-287: the send ledger for the twice-daily Dealer Validation digest email.
--
-- SUPERSEDED BY E-288, WHICH RENAMES THIS TABLE TO `digest_runs`.
--   Kept because it was APPLIED to database-1 and database-2 on 2026-09-07 and
--   the migration checklist records it as such. An applied migration keeps its
--   file: deleting it would leave the checklist pointing at nothing and the next
--   person unable to see what was actually run. A fresh database can skip
--   straight to E-288, whose CREATE TABLE IF NOT EXISTS covers this one.
--
-- WHY
--   Admin -> Dealer Validation (/admin/dealer-verification) is where dealer
--   onboarding applications are approved, rejected or sent back for correction.
--   Nothing told anyone what happened there: the four stat cards on that page are
--   computed in the BROWSER from the full application list, and this repo had no
--   scheduled summary email of any kind. This ships one -- 09:00 IST covering
--   yesterday, 19:00 IST covering today so far -- to the address(es) configured at
--   Settings -> Dealer Validation, with a button that opens the page.
--
-- WHAT THIS TABLE IS
--   NOT the digest's data. Every number in the mail is counted live from
--   dealer_onboarding_applications and dealer_correction_rounds at send time.
--   This table records only that a slot WAS SENT, and is what stops it being sent
--   twice.
--
-- THE PARTIAL UNIQUE INDEX IS THE LOCK
--   Three things can drive a send and any of them may be running at once: the
--   in-process ticker in src/instrumentation-node.ts (the primary path -- see
--   docs/DEPLOY_RUNBOOK.md on why vercel.json crons do NOT fire on the Hostinger
--   PM2 boxes), a VPS crontab curl, and a second PM2 process that also boots
--   instrumentation. Rather than coordinate them, each CLAIMS the slot with an
--   INSERT ... ON CONFLICT DO UPDATE ... WHERE and only the winner gets a row
--   back. This is the same trick ops_collector_runs_one_active_idx (E-210) plays
--   for the Ops collectors.
--
--   The index is PARTIAL on slot IN ('morning','evening') so a 'test' send from the
--   settings screen never consumes a real slot -- an admin testing the template at
--   09:30 must not suppress that morning's actual digest.
--
-- WHY A ROW SURVIVES A FAILED SEND
--   status='failed' + attempts is what makes a retry BOUNDED. The claim re-takes a
--   failed row up to 3 times, so a transient AgentMail 429 self-heals on the next
--   5-minute tick, while a mailbox that is permanently misconfigured stops after
--   three tries instead of mailing the error loop all day. A row stuck in 'sending'
--   (the process died mid-send) is reclaimable after 15 minutes.
--
-- SAFE TO SKIP AT DEPLOY
--   Every read and write in the runner is try/catch-guarded and a failure to claim
--   is treated as "someone else owns this slot", so an environment without this
--   table simply never sends a digest.
--
-- NOT THE DEAD COLUMN
--   dealer_onboarding_applications.correction_requested_at exists in schema.ts and
--   is NEVER WRITTEN by any route -- request-correction/route.ts sets only
--   onboarding_status/review_status. Verified: 0 populated rows against 3
--   applications sitting in correction. The digest counts corrections from
--   dealer_correction_rounds.created_at instead. Do not "fix" it by reading that
--   column.
--
-- Additive and idempotent -- safe to re-run.

CREATE TABLE IF NOT EXISTS dealer_validation_digest_runs (
  id            bigserial     PRIMARY KEY,
  digest_date   date          NOT NULL,
  slot          varchar(16)   NOT NULL,
  status        varchar(16)   NOT NULL,
  attempts      integer       NOT NULL DEFAULT 0,
  recipients    text,
  counts        jsonb         NOT NULL DEFAULT '{}'::jsonb,
  triggered_by  varchar(16)   NOT NULL DEFAULT 'ticker',
  message_id    text,
  error         text,
  claimed_at    timestamptz   NOT NULL DEFAULT now(),
  created_at    timestamptz   NOT NULL DEFAULT now()
);

-- THE CLAIM KEY. Partial so a 'test' send never consumes a real slot.
-- REPLACED BY digest_runs_kind_slot_uniq IN E-288, which adds `kind` to the key.
CREATE UNIQUE INDEX IF NOT EXISTS dealer_validation_digest_runs_slot_uniq
  ON dealer_validation_digest_runs (digest_date, slot)
  WHERE slot IN ('morning', 'evening');

CREATE INDEX IF NOT EXISTS dealer_validation_digest_runs_created_idx
  ON dealer_validation_digest_runs (created_at DESC);

COMMENT ON TABLE dealer_validation_digest_runs IS
  'E-287: send ledger for the twice-daily Dealer Validation digest email. Renamed to '
  'digest_runs by E-288 when a second digest kind arrived.';
