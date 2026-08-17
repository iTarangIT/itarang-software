-- E-241: scraper batch job queue — many commands x many cities, submitted once,
--        drained serially, optionally only inside a daily IST window.
--
-- WHY
--   The scraper form (src/components/scraper/QueryManager.tsx) is ONE free-text
--   input that posts { query } to POST /api/scraper/run, and that route holds a
--   GLOBAL single-run lock (409 while any run is 'running'). Covering ten
--   product phrasings across ten cities therefore means the operator sits at the
--   screen and starts a hundred runs by hand, one at a time, waiting for each.
--
--   The fan-out is not the missing piece. startChunkedRun() already crosses a
--   query list with a city list and writes one scraper_run_chunks row per
--   combination (E-227 documents this at length). What is missing is somewhere
--   to PARK the work: a durable list of "these hundred (query, city) pairs still
--   need running", so a submission survives the browser closing, a pm2 restart,
--   and the end of the working day.
--
--   That is all this table is. One row = one pending scrape. A dispatcher ticker
--   claims the oldest eligible row, creates an ordinary scraper_runs row for it,
--   and calls the existing startChunkedRun(). Nothing downstream changes: chunk
--   execution, finalize, dedupe, promotion into dealer_leads, the 2.5s progress
--   poll and the run-detail view all still see a perfectly normal run.
--
-- WHY A NEW TABLE AND NOT COLUMNS ON scraper_runs
--   scraper_runs is a trap, and the trap is written down in the code. See the
--   26-line comment at src/lib/db/schema.ts (~line 3246): `last_progress_at` was
--   once added to the scrapeRuns drizzle object without an applied migration,
--   and because Drizzle names EVERY column of a table object in its INSERT, the
--   first line of every scrape died with
--       column "last_progress_at" of relation "scraper_runs" does not exist
--   on every database. Seven scheduling columns on that table is seven more
--   chances to repeat it, on a table whose two duplicate declarations
--   (scraperRuns ~2618 and scrapeRuns ~3219) mean a mirror edit has to be made
--   against the right one.
--
--   A brand-new table cannot fail that way. If this file is unapplied on some
--   database, the new /api/scraper/batch routes 500 loudly and the existing
--   single-query scraper keeps working untouched. That is a strictly better
--   failure mode than taking the whole feature down, and it is the reason the
--   queue is its own relation rather than a widening of scraper_runs.
--
--   It is still a FLAT job list, not a parent campaign: batch_id is a grouping
--   LABEL for the UI, nothing rolls up through it, and every queue row becomes
--   its own independent run with its own progress, cancel and history entry.
--
-- WHY NOT scraper_city_queue
--   That table (base_query/state/city/full_query/status/leads_found/...) already
--   exists and is shaped almost right, but nothing has ever written it — it is
--   dead from an earlier design, and E-227 deliberately left it alone for the
--   same reason. It also has no batch, no schedule window and a NOT NULL `state`
--   this feature has no value for, so adopting it would mean altering a dead
--   table into a live one rather than creating a clean one. Left untouched.
--
-- WHY THE WINDOW COLUMNS LOOK LIKE THIS
--   varchar(5) 'HH:MM' + a jsonb day array is exactly the shape E-228 chose for
--   dialer_campaigns.window_start/window_end/window_days, which in turn mirrors
--   assignment_config.working_hours_start/working_days (E-120). Same vocabulary,
--   so one predicate can read either without a translation layer. Times are IST
--   (Asia/Kolkata) and are compared against Postgres now(), never a JS Date —
--   src/lib/nbfc/auction/scheduler.ts records what app-clock comparisons cost on
--   a pm2 VPS with drifting NTP.
--
--   schedule_mode is the whole of the recurrence model and it is deliberately
--   small:
--     'now'   — dispatch as soon as the dispatcher is free (default).
--     'once'  — dispatch when run_after has passed. Single run, no repeat.
--     'daily' — dispatch only while the IST clock is inside
--               [window_start, window_end) on a day listed in window_days.
--   "Recurring until every lead is processed" then needs NO pause/resume
--   bookkeeping at all: queued rows simply sit here while the window is shut and
--   the ticker picks them up again when it reopens, day after day, until none
--   are left. A job already dispatched when the window closes is allowed to
--   finish — the same rule E-228 sets for a call already in flight.
--
--   window_end > window_start is NOT assumed. An overnight window (22:00-06:00)
--   is legal and the reader handles the wrap; storing two plain HH:MM strings
--   keeps that decision in one predicate instead of in the data.
--
-- WHY status IS A PLAIN varchar WITH NO CHECK
--   Per this table family's convention (E-202, E-218, E-220, E-221, E-226,
--   E-230, E-231, E-232, E-237, E-238): the vocabulary
--   'queued' | 'running' | 'done' | 'failed' | 'cancelled'
--   lives in src/lib/scraper/jobQueue.ts and is enforced by zod at the write
--   path. A CHECK constraint here would turn a vocabulary extension into a
--   migration on every database.
--
-- WHY seq
--   Batch order is the operator's order — the row order of their spreadsheet,
--   or the order they typed the commands. created_at alone cannot express it
--   because every row of a submission is inserted in the same statement and can
--   share a timestamp to the microsecond. seq is what makes "run my cities in
--   the order I listed them" true rather than incidental.
--
-- DEPENDS ON E-227_scraper_multi_query — apply that first. Without
--   scraper_runs.last_progress_at the reaper still force-fails any run older
--   than 10 minutes, and the dispatcher calls it on every 30s tick, so a
--   legitimately long queued job would be killed at minute 11. E-227 is
--   idempotent; re-running it where it is already present is a no-op.
--
-- REQUIRED?
--   YES for the batch feature — every /api/scraper/batch route reads or writes
--   this table and the dispatcher ticker claims from it. NOT required for the
--   pre-existing single-query scraper, which does not reference it at all.
--
-- Additive, idempotent, and safe to re-run. No column is dropped, no type is
-- narrowed, nothing is retroactively SET NOT NULL.
-- Apply via pgAdmin Query Tool (never db:push).

BEGIN;

-- ── 1. The queue ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scraper_job_queue (
    id              text        PRIMARY KEY,
    batch_id        text        NOT NULL,
    seq             integer     NOT NULL DEFAULT 0,
    query_text      text        NOT NULL,
    city            text,
    max_results     integer,
    expand_with_ai  boolean     NOT NULL DEFAULT false,
    status          varchar(16) NOT NULL DEFAULT 'queued',
    run_id          varchar(255),
    attempts        integer     NOT NULL DEFAULT 0,
    last_error      text,
    schedule_mode   varchar(16) NOT NULL DEFAULT 'now',
    run_after       timestamptz,
    window_start    varchar(5),
    window_end      varchar(5),
    window_days     jsonb,
    created_by      uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    dispatched_at   timestamptz,
    finished_at     timestamptz,
    leads_promoted  integer     NOT NULL DEFAULT 0
);

COMMENT ON TABLE scraper_job_queue IS
    'E-241: pending scraper work. One row = one (query, city) pair waiting to become '
    'a scraper_runs row. Claimed one at a time by the in-process dispatcher in '
    'src/instrumentation-node.ts (startScraperQueueTicker) via jobQueue.dispatchOnce().';

COMMENT ON COLUMN scraper_job_queue.batch_id IS
    'E-241: groups the rows of one submission, e.g. ''SBATCH-a1b2c3d4''. A LABEL for '
    'the UI only — there is no batch entity and nothing rolls up through it. Every '
    'row still becomes its own independent run.';

COMMENT ON COLUMN scraper_job_queue.seq IS
    'E-241: position within the batch, 0-based. Dispatch orders by (seq, created_at) '
    'so the operator''s spreadsheet order is honoured; created_at alone cannot, since '
    'a whole submission is inserted in one statement and shares a timestamp.';

COMMENT ON COLUMN scraper_job_queue.query_text IS
    'E-241: one search command, already trimmed/lowercased and 3w-normalised. Passed '
    'to startChunkedRun() as the base query.';

COMMENT ON COLUMN scraper_job_queue.city IS
    'E-241: the single city this job searches. NULL means the operator supplied no '
    'city list, so generateCitiesForQuery() picks them — i.e. exactly the pre-E-241 '
    'single-query behaviour.';

COMMENT ON COLUMN scraper_job_queue.max_results IS
    'E-241: optional per-row cap from the Excel template''s max_results column. NULL '
    '= use the pipeline defaults (MAX_PAGES_PER_QUERY).';

COMMENT ON COLUMN scraper_job_queue.expand_with_ai IS
    'E-241: when true, startChunkedRun() expands query_text into ~15 Gemini variations '
    'before crossing with the city (~15 chunks per job). When false — the default and '
    'the UI default — the command is used LITERALLY, one chunk per job: predictable '
    'cost, and no Gemini 429 can fail the fan-out.';

COMMENT ON COLUMN scraper_job_queue.status IS
    'E-241: queued | running | done | failed | cancelled. No CHECK and no enum — the '
    'vocabulary lives in src/lib/scraper/jobQueue.ts and is enforced by zod at the '
    'write path, per this table family''s convention (cf. E-226/E-231/E-237/E-238).';

COMMENT ON COLUMN scraper_job_queue.run_id IS
    'E-241: the scraper_runs row created when this job was dispatched. Soft FK, no '
    'DB-level constraint — a missing parent should be a dangling id somebody can '
    'repair, not a failed INSERT at dispatch time.';

COMMENT ON COLUMN scraper_job_queue.attempts IS
    'E-241: incremented inside the claim. Nothing retries automatically today; this '
    'exists so a future retry policy has a counter and so a job that keeps being '
    'claimed and failing is visible rather than silent.';

COMMENT ON COLUMN scraper_job_queue.schedule_mode IS
    'E-241: now | once | daily. ''now'' dispatches as soon as the dispatcher is free. '
    '''once'' waits for run_after. ''daily'' dispatches only inside the IST window and '
    'resumes there each day until the queue is empty — which is the whole of the '
    'recurring-campaign model, with no pause/resume state to keep.';

COMMENT ON COLUMN scraper_job_queue.run_after IS
    'E-241: earliest instant this job may dispatch, for schedule_mode=''once''. '
    'Compared against Postgres now(), never a JS Date.';

COMMENT ON COLUMN scraper_job_queue.window_start IS
    'E-241: earliest local (IST) time this job may START, ''HH:MM''. Same shape as '
    'dialer_campaigns.window_start (E-228) and assignment_config.working_hours_start '
    '(E-120). NULL unless schedule_mode=''daily''.';

COMMENT ON COLUMN scraper_job_queue.window_end IS
    'E-241: latest local (IST) time this job may START, ''HH:MM''. A job already '
    'dispatched at this time runs to completion. window_end < window_start is legal '
    'and means an overnight window (22:00-06:00); the reader handles the wrap.';

COMMENT ON COLUMN scraper_job_queue.window_days IS
    'E-241: weekdays this job may run, e.g. ["mon","tue","wed","thu","fri"]. Same '
    'vocabulary as assignment_config.working_days and dialer_campaigns.window_days. '
    'NULL = every day.';

COMMENT ON COLUMN scraper_job_queue.leads_promoted IS
    'E-241: copied off scraper_runs.new_leads_promoted by reconcileFinishedJobs() '
    'when the run reaches a terminal status, so batch totals do not need a join.';

-- ── 2. The claim path ────────────────────────────────────────────────────────
-- dispatchOnce() claims with
--   WHERE status='queued' AND <window predicate> ORDER BY created_at, seq
--   LIMIT 1 FOR UPDATE SKIP LOCKED
-- Partial, because queued rows shrink to a minority of the table as a batch
-- drains and every dispatch tick (30s) probes this predicate.
--
-- created_at FIRST, seq SECOND, and the order matters more than it looks. Every
-- row of one submission is inserted in a single statement and therefore shares
-- created_at exactly, so this reads as "oldest batch first, and within it the
-- operator's own row order" — batches drain one after another, FIFO.
--
-- Leading with seq instead would sort ACROSS batches: seq restarts at 0 for
-- every submission, so all the 0s would run, then all the 1s, and three
-- concurrent batches would round-robin. Nothing would finish until nearly
-- everything had, every batch's progress bar would crawl at once, and no
-- operator could be told when their own batch would be done.
CREATE INDEX IF NOT EXISTS idx_scraper_job_queue_claim
    ON scraper_job_queue (created_at, seq)
    WHERE status = 'queued';

-- ── 3. The batch list and detail views ───────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_scraper_job_queue_batch
    ON scraper_job_queue (batch_id, seq);

-- ── 4. reconcileFinishedJobs() joins back from the run ───────────────────────
CREATE INDEX IF NOT EXISTS idx_scraper_job_queue_run
    ON scraper_job_queue (run_id)
    WHERE run_id IS NOT NULL;

COMMIT;
