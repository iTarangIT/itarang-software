-- E-187 — Give the risk engine a run record, a lock, and a freshness signal.
--
-- Until now `runRiskWorkflow` had exactly one caller: the "Re-run analysis"
-- button. Nothing scheduled it, nothing recorded that it happened, nothing
-- stopped two of them running at once, and a card carried no evidence of which
-- run produced it. The page said "N active hypotheses" whether the numbers were
-- computed an hour ago or in March.
--
-- risk_runs is the missing row: one per invocation, with the outcome counts and
-- a status. It doubles as the concurrency lock (see the partial unique index)
-- and as the freshness source for the Risk page.
--
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS risk_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL,
  -- 'manual' (the button) | 'cron' (the nightly job). NOT named "trigger":
  -- that is a reserved word in Postgres and would need quoting forever.
  triggered_by        varchar(16) NOT NULL,
  actor_user_id       uuid,
  status              varchar(16) NOT NULL DEFAULT 'running',  -- running | completed | failed
  started_at          timestamptz NOT NULL DEFAULT NOW(),
  finished_at         timestamptz,

  cards_generated     integer     NOT NULL DEFAULT 0,
  cards_computed      integer     NOT NULL DEFAULT 0,
  cards_inconclusive  integer     NOT NULL DEFAULT 0,
  cards_errored       integer     NOT NULL DEFAULT 0,
  prompt_tokens       integer     NOT NULL DEFAULT 0,
  completion_tokens   integer     NOT NULL DEFAULT 0,
  error               text
);

-- The lock. At most one running row per tenant, enforced by the database rather
-- than by a check-then-insert that two concurrent requests can both win.
-- A crashed run leaves a stale 'running' row; beginRiskRun() reaps those (marks
-- them 'failed') before it tries to insert, so this cannot wedge permanently.
CREATE UNIQUE INDEX IF NOT EXISTS risk_runs_one_active_per_tenant_idx
  ON risk_runs (tenant_id) WHERE status = 'running';

CREATE INDEX IF NOT EXISTS risk_runs_tenant_started_idx
  ON risk_runs (tenant_id, started_at DESC);

-- Which run produced this card. Nullable: every row written before E-187
-- predates run tracking and has no run to point at.
ALTER TABLE risk_card_runs
  ADD COLUMN IF NOT EXISTS run_id uuid;

CREATE INDEX IF NOT EXISTS risk_card_runs_run_id_idx
  ON risk_card_runs (run_id);

COMMENT ON TABLE risk_runs IS
  'One row per risk-engine invocation. Also the concurrency lock (partial unique index on status=running) and the freshness source for the Risk page.';
