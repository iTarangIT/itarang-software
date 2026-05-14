-- E-109 — dialer_campaigns + dialer_campaign_leads.
--
-- Persists every AI dialer "run" as a campaign so the UI can show:
--   1. Per-lead progress on the live banner (pending / calling / completed),
--      with the per-lead outcome (push_to_crm, schedule_call, uninterested, …).
--   2. History of past campaigns on a new "Campaigns" tab on /leads, mirroring
--      the existing scraper_runs UX.
--
-- Before this migration, dialer state was Redis-only (see
-- src/lib/queue/dialerSession.ts) — once a session ended, there was no way
-- to recover "what region was this campaign? who triggered it? which leads
-- got called?".
--
-- The parent/child split mirrors scraper_runs + scraper_run_chunks: status
-- and counters on the parent, one row per lead on the child with its own
-- status lifecycle. region_filter is the RegionSelection JSON that the
-- DialerStartModal emits — verbatim — so we can reproduce the dialer scope
-- of any historical campaign.
--
-- Idempotent: every CREATE has IF NOT EXISTS. Re-running this file is a
-- no-op. Strictly additive — no DROP / no narrowing. Apply via pgAdmin
-- Query Tool against AWS Postgres (see project memory: db_runtime).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. dialer_campaigns — one row per dialer run.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dialer_campaigns (
    id               text PRIMARY KEY,
    name             text NOT NULL,
    triggered_by     uuid,
    provider         text NOT NULL,
    category         text,
    region_filter    jsonb,
    status           text NOT NULL DEFAULT 'running',
    total_leads      integer NOT NULL DEFAULT 0,
    calls_made       integer NOT NULL DEFAULT 0,
    completed_leads  integer NOT NULL DEFAULT 0,
    failed_leads     integer NOT NULL DEFAULT 0,
    started_at       timestamptz NOT NULL DEFAULT now(),
    completed_at     timestamptz,
    stopped_by       uuid,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dialer_campaigns_status
    ON dialer_campaigns (status);

CREATE INDEX IF NOT EXISTS idx_dialer_campaigns_triggered_by_started
    ON dialer_campaigns (triggered_by, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_dialer_campaigns_started_at
    ON dialer_campaigns (started_at DESC);

-- ---------------------------------------------------------------------------
-- 2. dialer_campaign_leads — one row per (campaign, lead).
--    lead_id is a soft FK to dealer_leads.id (text PK there). We don't
--    declare a hard FK because dealer_leads has been hand-managed across
--    db:push runs and the production schema has known drift; better to
--    keep this loose than risk a constraint violation on apply.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dialer_campaign_leads (
    id              text PRIMARY KEY,
    campaign_id     text NOT NULL REFERENCES dialer_campaigns(id) ON DELETE CASCADE,
    lead_id         text NOT NULL,
    queue_position  integer NOT NULL,
    status          text NOT NULL DEFAULT 'pending',
    bolna_call_id   text,
    call_outcome    text,
    intent_score    integer,
    started_at      timestamptz,
    completed_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dialer_campaign_leads_campaign_status
    ON dialer_campaign_leads (campaign_id, status);

CREATE INDEX IF NOT EXISTS idx_dialer_campaign_leads_campaign_position
    ON dialer_campaign_leads (campaign_id, queue_position);

CREATE INDEX IF NOT EXISTS idx_dialer_campaign_leads_lead_status
    ON dialer_campaign_leads (lead_id, status);

-- Webhook fallback path: find the most recent in-flight row for a lead when
-- the Redis session has been GC'd. Partial index keeps it tiny since the
-- vast majority of rows are 'completed' / 'failed' in steady state.
CREATE INDEX IF NOT EXISTS idx_dialer_campaign_leads_active
    ON dialer_campaign_leads (lead_id, created_at DESC)
    WHERE status IN ('calling', 'pending');

-- ---------------------------------------------------------------------------
-- 3. Healing pass — idempotent. Catches the legacy bug where a campaign was
--    stopped mid-call before the /stop endpoint drained in-flight rows.
--    Any 'calling' row whose parent campaign is already terminal (stopped /
--    completed / failed) is rewritten to 'failed' with the appropriate
--    outcome. Re-running this block is a no-op once rows are consistent.
-- ---------------------------------------------------------------------------
WITH orphans AS (
    UPDATE dialer_campaign_leads dcl
       SET status        = 'failed',
           completed_at  = COALESCE(dcl.completed_at, c.completed_at, now()),
           call_outcome  = COALESCE(dcl.call_outcome, 'stopped_by_user')
      FROM dialer_campaigns c
     WHERE c.id = dcl.campaign_id
       AND c.status IN ('stopped', 'completed', 'failed')
       AND dcl.status = 'calling'
    RETURNING dcl.campaign_id
)
UPDATE dialer_campaigns c
   SET calls_made   = c.calls_made   + sub.n,
       failed_leads = c.failed_leads + sub.n
  FROM (
        SELECT campaign_id, COUNT(*)::int AS n
          FROM orphans
         GROUP BY campaign_id
       ) sub
 WHERE sub.campaign_id = c.id;

COMMIT;

-- Verification:
--   SELECT COUNT(*) FROM dialer_campaigns;        -- expect 0 on first apply
--   SELECT COUNT(*) FROM dialer_campaign_leads;   -- expect 0 on first apply
--   \d dialer_campaigns
--   \d dialer_campaign_leads
--
--   -- After re-running on an existing DB with the legacy bug:
--   SELECT dcl.id, dcl.status, c.status AS campaign_status
--     FROM dialer_campaign_leads dcl
--     JOIN dialer_campaigns c ON c.id = dcl.campaign_id
--    WHERE dcl.status = 'calling' AND c.status IN ('stopped','completed','failed');
--   -- expect 0 rows
