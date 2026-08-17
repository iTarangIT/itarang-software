------------------------------------------------------------------------------
-- E-244: per-card SLA windows for the KYC auto-approval sweep.
--
-- WHAT CHANGES. E-242 gave a case ONE deadline: `admin_verification_queue
-- .sla_due_at`, stamped at dealer submit, and when it passed the sweep accepted
-- every pending verification card at once. Admins want the windows to differ by
-- card — 20 minutes is plenty for Aadhaar, an Equifax pull deserves an hour —
-- so each card now has its own deadline and is accepted on its own clock.
--
-- THE CASE IS ONLY APPROVED WHEN THE LAST CARD'S WINDOW HAS CLOSED. Approving
-- while a card is still inside its review window would make that window
-- meaningless, so `sla_due_at` stops being the moment everything happens and
-- becomes the case-level floor; the sweep finalises once it AND every card
-- deadline have passed.
--
-- THE TWO COLUMNS.
--
-- `sla_card_due_at` — a snapshot of the resolved per-card deadlines, written at
--   submit: {"aadhaar":"…Z","pan":"…Z","bank":"…Z","cibil":"…Z","rc":"…Z"}.
--   It is a SNAPSHOT rather than a lookup at sweep time on purpose, and this is
--   the same rule the rest of the feature already lives by: the settings screen
--   promises that changing a window only affects cases submitted from now on,
--   and a case already in the queue keeps the deadlines it was admitted under.
--   Resolving the windows when the sweep fires would quietly break that.
--
-- `sla_next_due_at` — the scheduler's pointer: the earliest deadline this row
--   still has to act on. Stamped at submit as the minimum of the case deadline
--   and every card deadline, then advanced by the sweep as each card matures.
--   A case now needs visiting several times (once per distinct window) where
--   E-242 visited it exactly once, and this is what keeps that selection on an
--   index instead of a scan of every open queue row on every 60-second tick.
--
-- NULL IS STILL "NEVER". Both columns are NULL for every row that predates this
-- file and for everything submitted while the feature is off. The sweep skips
-- NULL and falls back to `sla_due_at`, so a pre-E-244 case keeps behaving
-- exactly as E-242 left it: all its cards mature together on the case deadline.
-- There is deliberately NO BACKFILL — same reason as E-243.
--
-- REQUIRED BEFORE THE CODE DEPLOYS. `admin_verification_queue` is mirrored in
-- schema.ts and read with bare `db.select()`, and Drizzle names every column of
-- a mirrored table in its generated SQL — so on a database without this file the
-- KYC review page fails on its first read with
-- `column "sla_card_due_at" does not exist`. The automation stays inert
-- regardless: `app_settings` key `kyc_auto_approval` ships `enabled=false`.
--
-- Additive and idempotent — safe to re-run. Guarded so it is a reported no-op
-- on a database without the table.
------------------------------------------------------------------------------

BEGIN;

-- 1. The per-card deadline snapshot -----------------------------------------
DO $do$ BEGIN
    ALTER TABLE admin_verification_queue
        ADD COLUMN IF NOT EXISTS sla_card_due_at jsonb;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: admin_verification_queue does not exist';
END; $do$;

-- 2. The scheduler pointer ---------------------------------------------------
DO $do$ BEGIN
    ALTER TABLE admin_verification_queue
        ADD COLUMN IF NOT EXISTS sla_next_due_at timestamptz;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: admin_verification_queue does not exist';
END; $do$;

-- 3. Keeps the 60s sweep off a sequential scan -------------------------------
-- PARTIAL, and the predicate mirrors the sweep's own WHERE clause exactly: only
-- rows still open and not yet finalised are ever selected. Drizzle's index
-- builder has no WHERE clause, so this index is migration-only and must never be
-- recreated from schema.ts — a same-named index built without the predicate
-- would satisfy a name-only check while scanning every open queue row on every
-- tick, and CREATE INDEX IF NOT EXISTS could never repair it afterwards.
DO $do$ BEGIN
    CREATE INDEX IF NOT EXISTS admin_verification_queue_sla_next_due_idx
        ON admin_verification_queue (sla_next_due_at)
        WHERE sla_next_due_at IS NOT NULL
          AND auto_approved_at IS NULL
          AND status = 'pending_itarang_verification';
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: admin_verification_queue does not exist';
END; $do$;

-- 4. Self-documentation ------------------------------------------------------
DO $do$ BEGIN
    EXECUTE $c$COMMENT ON COLUMN admin_verification_queue.sla_card_due_at IS
        'E-244. Snapshot of the per-card auto-accept deadlines resolved at dealer submit, keyed by verification_type (aadhaar/pan/bank/cibil/rc), ISO-8601 values. A snapshot, not a lookup: a later change to the per-card windows must not move the deadlines of a case already in the queue. NULL means every card falls back to sla_due_at, which is how every pre-E-244 case behaves; do NOT backfill.'$c$;
EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'skip: comment (target table/column absent)';
END; $do$;

DO $do$ BEGIN
    EXECUTE $c$COMMENT ON COLUMN admin_verification_queue.sla_next_due_at IS
        'E-244. The earliest deadline this queue row still has to act on — the minimum of sla_due_at and the unmatured entries of sla_card_due_at. The sweep selects on this and advances it as each card matures, which is what lets one case be visited once per distinct window without scanning the whole queue. NULL falls back to sla_due_at (pre-E-244 rows); do NOT backfill.'$c$;
EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'skip: comment (target table/column absent)';
END; $do$;

COMMIT;
