-- =============================================================================
-- E-303 — SALES TARGETS: the target register (2026-09-21)
-- =============================================================================
-- WHY. Reporting Review v1.0 issue R-17 / sheet 8, Requirement #15: nothing in
-- the CRM was measured against a plan — there was no targets table at all.
--
-- WHAT CHANGED (additive; a new table, nothing else touched):
--
--   sales_targets — one row per (month, person, metric)
--     month           date          first day of the target month
--     user_id         text          users.id of the person the target is for
--     metric          varchar(40)   vocabulary in src/lib/targets/metrics.ts
--                                   (enforced in code, not a CHECK, so the list
--                                   can grow without DDL)
--     ceo_target      numeric       set by the CEO
--     admin_addon     numeric ≥ 0   admin may ADD, never reduce (#15) — the
--                                   CHECK makes "never reduce" a DB guarantee
--     status          varchar(20)   draft → pending_approval → pushed → accepted
--     approved_by/_at, pushed_at, accepted_at, reminded_at
--     created_by, updated_by, created_at, updated_at
--   UNIQUE (month, user_id, metric)
--
-- Final monthly target = ceo_target + admin_addon (computed, never stored, so
-- the two can never disagree with it).
--
-- No backfill. Required before the targets code deploys (the page and API read
-- the table); nothing else depends on it, so old code on a new DB is unaffected.
--
-- Idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS sales_targets (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    month         date        NOT NULL,
    user_id       text        NOT NULL,
    metric        varchar(40) NOT NULL,
    ceo_target    numeric(14,2) NOT NULL DEFAULT 0,
    admin_addon   numeric(14,2) NOT NULL DEFAULT 0,
    status        varchar(20) NOT NULL DEFAULT 'draft',
    approved_by   text,
    approved_at   timestamptz,
    pushed_at     timestamptz,
    accepted_at   timestamptz,
    reminded_at   timestamptz,
    created_by    text,
    updated_by    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sales_targets_addon_not_negative CHECK (admin_addon >= 0),
    CONSTRAINT sales_targets_ceo_not_negative CHECK (ceo_target >= 0),
    CONSTRAINT sales_targets_month_is_first CHECK (EXTRACT(DAY FROM month) = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS sales_targets_month_user_metric_uniq
    ON sales_targets (month, user_id, metric);
CREATE INDEX IF NOT EXISTS sales_targets_user_month_idx
    ON sales_targets (user_id, month);
CREATE INDEX IF NOT EXISTS sales_targets_pushed_unaccepted_idx
    ON sales_targets (pushed_at) WHERE status = 'pushed';
