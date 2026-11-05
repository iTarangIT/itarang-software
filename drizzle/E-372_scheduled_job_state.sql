-- =============================================================================
-- E-372 — SCHEDULED JOB STATE: WHEN EACH JOB LAST RAN (ID 227)
-- =============================================================================
-- WHY.
--   Found 3 Nov (system check): vercel.json lists 22 scheduled jobs and none of
--   them fire on the PM2 servers; nothing recorded which jobs actually ran or
--   when. Business check: "Ops Console > Jobs lists every scheduled job with its
--   last run today."
--
-- WHAT. scheduled_job_state — one row per in-process job (the name its ticker
--   runs under, e.g. 'zoho-sync', 'dialer:poll'): when it last started and
--   finished, how it ended, the last error, and a run count. Written by the
--   tickers (src/lib/runtime/jobRuns.ts trackTick, at most once a minute per
--   job plus every failure); read by Ops Console > Jobs.
--
-- NOT mirrored in schema.ts — raw SQL behind a to_regclass probe, so the code
-- is safe in either order: without this table the tickers run as before and
-- Ops Console says the database change is pending.
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS scheduled_job_state (
    name              varchar(80) PRIMARY KEY,
    last_started_at   timestamptz,
    last_finished_at  timestamptz,
    last_status       varchar(16),
    last_error        text,
    last_failed_at    timestamptz,
    run_count         bigint NOT NULL DEFAULT 0,
    updated_at        timestamptz NOT NULL DEFAULT now()
);

DO $do$
BEGIN
    ALTER TABLE scheduled_job_state
        ADD CONSTRAINT scheduled_job_state_status_check
        CHECK (last_status IS NULL OR last_status IN ('ok', 'failed', 'running'));
EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE 'scheduled_job_state_status_check exists, skip';
END;
$do$;
