-- E-286: one digest ledger for many digest kinds.
--
-- WHY
--   E-285 shipped the twice-daily Dealer Validation digest. The KYC Review screen
--   needs the same thing -- a morning and an evening summary, its own recipients
--   and format settings, and a button onto its own queue. Everything about HOW a
--   digest is delivered is identical between the two: the (date, slot) claim, the
--   retry ceiling, the in-process ticker, the cron backstop, the settings screen,
--   the email chrome, the spreadsheet chrome. Only the NUMBERS differ.
--
--   So rather than a second near-duplicate ledger and a second near-duplicate
--   ticker, this migration widens E-285's ledger by one column and the code
--   becomes a kind-agnostic engine plus a small per-kind descriptor
--   (src/lib/digests/). Adding a third digest later is then a descriptor and a
--   sidebar entry, not another table.
--
--   This is the same call E-281 made when it extended city_default_loan_products
--   to also carry dealer rules rather than adding a second table: ONE ledger, ONE
--   verifier, ONE history panel, ONE precedence story.
--
-- THE RENAME
--   dealer_validation_digest_runs -> digest_runs. The table now holds KYC rows
--   too, and a name that says otherwise is how the next person mis-reads it.
--
--   THIS IS THE ONE STEP THAT IS NOT STRICTLY ADDITIVE, and it is safe only
--   because of exactly when it runs: E-285 was applied on 2026-09-07, the table
--   holds a single row, and NO DEPLOYED CODE READS IT -- the E-285 application
--   code has never been released. Doing this after a release would not be
--   acceptable. The rename is guarded on the absence of `digest_runs`, so
--   re-running is a no-op and a database that never had E-285 simply gets the
--   CREATE TABLE below.
--
-- THE CLAIM KEY WIDENS BY ONE COLUMN
--   E-285's partial unique index was on (digest_date, slot). Left in place it
--   would mean the Dealer Validation and KYC Review digests could not both send
--   on the same morning -- the second would silently read as "already sent".
--   Replacing a partial unique key has precedent: E-281 replaced E-280's
--   _active_key for the same class of reason (the old key forbade a combination
--   the new feature requires). The new key is strictly WIDER, so the rebuild
--   cannot fail on existing rows.
--
-- EXISTING ROWS ARE REINTERPRETED, NOT MIGRATED
--   `kind` defaults to 'dealer_validation', which is what every pre-E-286 row is.
--   No backfill, no DML.
--
-- SAFE TO SKIP AT DEPLOY
--   Same as E-285: every read and write in src/lib/digests/engine.ts is
--   try/catch-guarded and a failed claim reads as "someone else owns this slot",
--   so an environment without this migration sends no digests at all rather than
--   sending wrong ones. Nothing else selects the table.
--
--   BUT NOT SKIPPABLE ALONGSIDE E-285's CODE: an environment carrying E-285's
--   table and E-286's CODE would fail every claim on `column "kind" does not
--   exist` (swallowed, so it degrades to silence). Apply this whenever the
--   digests code is deployed.
--
-- Idempotent -- safe to re-run, in either order relative to E-285.

-- 1. Rename E-285's table, if it is still under its old name.
DO $do$ BEGIN
  IF to_regclass('public.digest_runs') IS NULL
     AND to_regclass('public.dealer_validation_digest_runs') IS NOT NULL THEN
    ALTER TABLE dealer_validation_digest_runs RENAME TO digest_runs;
    RAISE NOTICE 'renamed dealer_validation_digest_runs -> digest_runs';
  END IF;
END $do$;

-- 2. For a database that never had E-285 at all.
CREATE TABLE IF NOT EXISTS digest_runs (
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

-- 3. The new dimension. Default is what every existing row already is.
ALTER TABLE digest_runs
  ADD COLUMN IF NOT EXISTS kind varchar(32) NOT NULL DEFAULT 'dealer_validation';

-- 4. Replace the claim key. The old one is dropped under BOTH its possible names
--    (the index keeps its old name through a table rename).
DROP INDEX IF EXISTS dealer_validation_digest_runs_slot_uniq;
DROP INDEX IF EXISTS digest_runs_slot_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS digest_runs_kind_slot_uniq
  ON digest_runs (kind, digest_date, slot)
  WHERE slot IN ('morning', 'evening');

-- The history panel reads newest-first across all kinds.
DROP INDEX IF EXISTS dealer_validation_digest_runs_created_idx;
CREATE INDEX IF NOT EXISTS digest_runs_created_idx
  ON digest_runs (created_at DESC);

COMMENT ON TABLE digest_runs IS
  'E-286 (was dealer_validation_digest_runs, E-285): send ledger for every scheduled '
  'digest email. One row per (kind, digest_date, slot) CLAIM. Holds no digest DATA -- '
  'the numbers in each mail are counted live at send time by that kind''s descriptor '
  'in src/lib/digests/kinds/. Written only by src/lib/digests/engine.ts.';

COMMENT ON COLUMN digest_runs.kind IS
  'E-286: which digest this row belongs to -- ''dealer_validation'' | ''kyc_review''. '
  'Must match a descriptor id in src/lib/digests/registry.ts. Defaults to '
  '''dealer_validation'' because that is what every row written before E-286 is.';

COMMENT ON COLUMN digest_runs.digest_date IS
  'E-285: the IST CALENDAR DAY the mail covers, not the day it was sent. The 09:00 '
  'slot covers YESTERDAY, so a mail sent on the 7th carries digest_date 2026-09-06. '
  'IST, not UTC: the boxes run UTC and a UTC day would bucket every 00:00-05:29 IST '
  'action into the wrong day.';

COMMENT ON COLUMN digest_runs.slot IS
  'E-285: ''morning'' | ''evening'' | ''test''. Only the first two are covered by '
  'digest_runs_kind_slot_uniq -- a ''test'' send from the settings screen is recorded '
  'for the audit trail but never suppresses a real slot.';

COMMENT ON COLUMN digest_runs.status IS
  'E-285: ''sending'' (claimed, in flight) | ''sent'' | ''failed''. A ''sent'' row is '
  'terminal and can never be reclaimed; that is what makes the slot once-a-day.';

COMMENT ON COLUMN digest_runs.attempts IS
  'E-285: how many times this slot has been claimed. The claim re-takes a ''failed'' '
  'row only while attempts < 3, so a transient provider error self-heals on the next '
  'tick but a permanently broken mailbox does not retry every 5 minutes all day.';

COMMENT ON COLUMN digest_runs.counts IS
  'E-285: the figures that were actually mailed, kept so the settings screen can show '
  'them beside a past send and so a disputed number can be checked against what the '
  'mail said rather than recomputed.';

COMMENT ON COLUMN digest_runs.triggered_by IS
  'E-285: ''ticker'' (src/instrumentation-node.ts, the primary path) | ''cron'' '
  '(/api/cron/digest, the VPS crontab backstop) | ''manual'' (the settings screen''s '
  'Send test now button).';

COMMENT ON COLUMN digest_runs.claimed_at IS
  'E-285: when the claim was taken. A row left in ''sending'' because the process died '
  'mid-send is reclaimable once this is older than 15 minutes.';
