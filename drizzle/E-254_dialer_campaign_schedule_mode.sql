-- E-254: AI dialer campaign EXECUTION TYPE — single run vs recurring.
--
-- WHY
--   E-228 gave dialer_campaigns a calling window (window_start / window_end /
--   window_days) and the pause/resume bookkeeping to go with it (paused_at,
--   resume_after, last_advanced_at). What it did NOT give it is a way to say
--   what should happen when the window closes, because it assumed exactly one
--   answer: pause now, wake up tomorrow.
--
--   The requirement has two answers:
--
--     Single run — dial inside today's window, and when the end time arrives
--                  pause and STAY paused. Remaining leads are left pending and
--                  a human decides when to pick them up again.
--     Recurring  — dial inside the window every configured day, pausing at the
--                  end time and resuming automatically at the next start time,
--                  until every lead has been processed.
--
--   Those differ only in what happens at close, so one column carries the whole
--   distinction. Recurring closes to status='scheduled' with resume_after set,
--   which the resume ticker claims. Single closes to status='paused' with
--   resume_after NULL, which nothing claims.
--
-- WHY A COLUMN AND NOT A KEY IN region_filter
--   region_filter is the verbatim RegionSelection blob emitted by
--   DialerStartModal, stored unread so a historical campaign's SCOPE is
--   reproducible. The execution type is not scope, it is lifecycle — and more
--   concretely, the window predicate and the resume ticker's claim are SQL, and
--   SQL cannot read a jsonb key on the indexed path these run on.
--
-- WHY 'now' | 'single' | 'recurring' AND NOT E-241's 'now' | 'once' | 'daily'
--   E-241 (scraper_job_queue) and E-228 deliberately share the 'HH:MM' +
--   ["mon","tue",…] vocabulary so one reader can serve both, and reusing
--   schedule_mode's name here continues that. The VALUES deliberately diverge.
--
--   E-241's 'once' fires at an INSTANT (run_after <= now(), then the job is
--   done). Our 'single' runs a WINDOW and then stops — a different thing that
--   would be actively misleading under the same word. 'daily' likewise implies
--   every day, whereas 'recurring' here honours window_days and may be
--   Mon/Wed/Fri. Same concept family, different semantics, different words.
--
-- WHY FREE TEXT, NO CHECK AND NO pgEnum
--   The convention this family has followed since E-202 (also E-218, E-220,
--   E-221, E-228). The vocabulary lives in TypeScript and is enforced by zod at
--   the write path; ALTER TYPE on a shared drifting DB is precisely what these
--   conventions exist to avoid.
--
-- BACKWARD COMPATIBILITY
--   DEFAULT 'now' means every existing campaign, and every campaign created by
--   a caller that does not know about scheduling, dials continuously exactly as
--   it does today. 'now' short-circuits the window predicate before it ever
--   looks at the window columns, so a row with schedule_mode='now' and stale
--   window values still behaves as unscheduled.
--
--   NOT NULL is safe here despite the house rule against retroactive SET NOT
--   NULL: ADD COLUMN ... NOT NULL DEFAULT fills every existing row with the
--   default in the same statement. No row can be left violating it.
--
-- REQUIRED?
--   YES. Drizzle names every column of dialer_campaigns in its INSERTs, so an
--   unapplied DB throws "column schedule_mode does not exist" the moment ANY
--   campaign is created — scheduled or not. This is a hard dependency, not a
--   feature flag.
--
-- Depends on E-228 (the window + pause/resume columns) and, transitively, on
-- E-109 (dialer_campaigns). Neither is altered here.
--
-- NOTE ON E-228's CHECKLIST ROW: MIGRATION_CHECKLIST.md records E-228 as
-- unapplied everywhere. That is stale — a live information_schema read of the
-- sandbox database on 2026-08-19 found all six columns and
-- idx_dialer_campaigns_resume present. Re-verify with `npm run db:drift` rather
-- than trusting either the checklist or this note.
--
-- Additive, idempotent, and safe to re-run. No column is dropped, no type is
-- narrowed, nothing is retroactively SET NOT NULL on existing data.
-- Apply via pgAdmin Query Tool (never db:push).

-- ── 1. The execution type ────────────────────────────────────────────────────
ALTER TABLE dialer_campaigns
    ADD COLUMN IF NOT EXISTS schedule_mode varchar(16) NOT NULL DEFAULT 'now';

COMMENT ON COLUMN dialer_campaigns.schedule_mode IS
    'How this campaign treats its calling window. ''now'' = unscheduled, dial '
    'continuously (pre-E-228 behaviour, the default). ''single'' = dial inside '
    'the window once, then pause to status=''paused'' and wait for a human. '
    '''recurring'' = dial inside the window on every day listed in window_days, '
    'pausing to status=''scheduled'' at the end time and resuming automatically '
    'at the next start time until the queue is empty.';

-- ── 2. Restate the status vocabulary ─────────────────────────────────────────
-- E-228 introduced 'scheduled'; this file adds 'paused'. Recording the whole
-- set in one place because there is no CHECK and no enum to read it off.
COMMENT ON COLUMN dialer_campaigns.status IS
    'draft — created but never started (List-upload flow). '
    'running — actively placing calls. '
    'scheduled — the calling window is shut and resume_after is armed; the '
    'resume ticker flips it back to running when resume_after <= now(). Covers '
    'both a campaign started before its window opened and a recurring campaign '
    'waiting for its next day. '
    'paused — a single-run campaign reached its window end time. resume_after '
    'is NULL and nothing claims it; only a human resumes it. '
    'completed — every lead processed. '
    'stopped — a human pressed Force stop, or the stall watchdog gave up. '
    'failed — reserved; no caller writes it. '
    'Free text by convention (see E-202, E-228): no CHECK, no pgEnum. The '
    'vocabulary lives in TypeScript and is enforced by zod at the write path.';

-- ── 3. No new index ──────────────────────────────────────────────────────────
-- The resume ticker's only predicate is
--   status = 'scheduled' AND resume_after <= now()
-- which E-228's partial idx_dialer_campaigns_resume already covers exactly.
-- schedule_mode is never selected on; it is only read once a row is in hand.
