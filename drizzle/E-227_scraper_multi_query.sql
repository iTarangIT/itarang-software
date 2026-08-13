-- E-227: multi-query / multi-city scrape runs — progress heartbeat and
--        per-combination attribution.
--
-- WHY
--   The scraper UI (src/components/scraper/QueryManager.tsx) is a single text
--   input, so covering "Lithium Battery Prayagraj", "Sukhi Battery Prayagraj"
--   and "Port Lithium Battery Prayagraj" means three separate runs — and
--   POST /api/scraper/run holds a GLOBAL single-run lock (409 while any run is
--   'running'), so the operator has to sit and wait between each one.
--
--   The fan-out itself already exists: startChunkedRun() builds a query x city
--   cartesian product and writes one scraper_run_chunks row per combination.
--   What is missing is the ability to SUPPLY those two lists. Once the user can,
--   a run goes from ~300-450 combinations (15 AI variations x 20-30 AI cities)
--   to ~1,500 (10 user queries -> ~150 AI variations x 10 user cities), and two
--   pre-existing behaviours become fatal rather than merely untidy.
--
-- WHY last_progress_at (THE RUN-KILLER)
--   reapStuckRuns() in src/lib/scraper/storage/runStore.ts force-fails ANY run
--   whose status is 'running' and whose started_at is older than
--   STUCK_RUN_THRESHOLD_MS = 10 minutes, and it is called at the top of
--   POST /api/scraper/run and /api/scraper/cron. A 1,500-chunk run takes hours,
--   so it would be marked 'failed' at minute 11 while its chunks kept working —
--   the run row lies, finalize never fires, and the leads are stranded in
--   scraper_raw.
--
--   The fix is to reap on SILENCE, not on AGE. executeChunk() already does one
--   atomic UPDATE per finished chunk (completed_chunks = completed_chunks + 1);
--   stamping last_progress_at in that same statement costs nothing and gives the
--   reaper a real liveness signal:
--
--     WHERE status = 'running'
--       AND COALESCE(last_progress_at, started_at) < now() - interval '20 minutes'
--
--   COALESCE is load-bearing: rows written before this migration have a NULL
--   heartbeat and must keep falling back to started_at, or an in-flight run at
--   deploy time would become unreapable.
--
-- WHY query_text AND city ON scraper_run_chunks
--   The table stores only combination_query — the joined string
--   "<variation> in <city>". With one query and AI-chosen cities that was
--   enough. With ten user queries across ten user cities, "which of my cities
--   actually produced dealers?" is the first question asked of a finished run,
--   and it is not answerable by parsing " in " back out of a string that may
--   legitimately contain it. Storing the two components at fan-out time is the
--   only reliable source. Both are nullable: chunks written before this
--   migration have no components to backfill, and the UI treats NULL as
--   "unattributed" rather than guessing.
--
-- WHY NOT scraper_city_queue
--   That table (base_query/state/city/full_query/status/leads_found/...) already
--   exists and has exactly the right shape, but NOTHING WRITES IT — it is dead
--   from an earlier design. Adopting it would mean maintaining a second work
--   queue alongside scraper_run_chunks, which the pipeline actually drives, and
--   keeping the two consistent through cancel and finalize. Two columns on the
--   live table is far less surface. scraper_city_queue is left untouched.
--
-- WHY THE INDEXES
--   scraper_run_chunks has NO index on run_id, and /api/scraper/runs/[id]/progress
--   polls "WHERE run_id = ? GROUP BY status" every 2.5s against a table that now
--   holds ~1,500 rows per run — a sequential scan on every tick of a multi-hour
--   run.
--
--   The partial (status, created_at) index serves the new in-process chunk-drain
--   ticker, which claims work with
--   "WHERE status = 'pending' ORDER BY created_at LIMIT n FOR UPDATE SKIP LOCKED"
--   on a table whose pending rows are a shrinking minority of the total.
--
-- NOTE ON THE DUPLICATE SCHEMA DECLARATION
--   src/lib/db/schema.ts declares this ONE physical table TWICE — scraperRuns
--   (line ~2592) and scrapeRuns (line ~3193), both pgTable("scraper_runs"), with
--   different column sets. Call sites import whichever alias they were written
--   against. This migration mirrors into scrapeRuns only (the alias the chunked
--   pipeline and runStore use). Reconciling the duplication is a separate change
--   with its own blast radius and is deliberately NOT attempted here.
--
-- REQUIRED?
--   YES for scraper_runs.last_progress_at and both scraper_run_chunks columns —
--   Drizzle names every column of a table in its INSERT/UPDATE statements, so an
--   unapplied DB throws "column does not exist" on the first chunk write and the
--   scraper is dead, not degraded.
--
-- Additive, idempotent, and safe to re-run. No column is dropped, no type is
-- narrowed, nothing is retroactively SET NOT NULL.
-- Apply via pgAdmin Query Tool (never db:push).

-- ── 1. Run-level liveness heartbeat ──────────────────────────────────────────
ALTER TABLE scraper_runs
    ADD COLUMN IF NOT EXISTS last_progress_at timestamptz;

COMMENT ON COLUMN scraper_runs.last_progress_at IS
    'Bumped by executeChunk() each time a chunk finishes. reapStuckRuns() reaps on '
    'silence (COALESCE(last_progress_at, started_at) older than the threshold) rather '
    'than on total run age, so a legitimately long multi-query run is not force-failed.';

-- ── 2. Per-combination attribution ───────────────────────────────────────────
ALTER TABLE scraper_run_chunks
    ADD COLUMN IF NOT EXISTS query_text text;

ALTER TABLE scraper_run_chunks
    ADD COLUMN IF NOT EXISTS city text;

COMMENT ON COLUMN scraper_run_chunks.query_text IS
    'The expanded search-query variation for this chunk, without the city. NULL for '
    'chunks created before E-227 (combination_query is all they have).';

COMMENT ON COLUMN scraper_run_chunks.city IS
    'The city this chunk searched. NULL for chunks created before E-227. Drives the '
    'per-city breakdown on the run-detail view.';

-- ── 3. Indexes for the progress poll and the drain ticker ────────────────────
CREATE INDEX IF NOT EXISTS idx_scraper_run_chunks_run_id
    ON scraper_run_chunks (run_id);

CREATE INDEX IF NOT EXISTS idx_scraper_run_chunks_pending
    ON scraper_run_chunks (status, created_at)
    WHERE status = 'pending';

-- ── 4. Reap-on-silence support ───────────────────────────────────────────────
-- Partial index over live runs only; the reaper and the single-run lock both
-- probe "is anything running right now?" on every scrape start.
CREATE INDEX IF NOT EXISTS idx_scraper_runs_running
    ON scraper_runs (status, last_progress_at)
    WHERE status = 'running';
