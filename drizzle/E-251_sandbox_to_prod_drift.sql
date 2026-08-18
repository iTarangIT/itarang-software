-- E-251 — Close the structural gap between sandbox (database-1) and production
-- (database-2).
--
-- PROVENANCE. Generated from `npm run db:drift` on 2026-08-18 (report:
-- docs/db/drift/2026-08-18-1417/). Diff 3 — "sandbox vs production" — is a live
-- introspection of BOTH databases (scripts/db-helpers/introspect.ts reads every
-- BASE TABLE in the `public` schema), so this is what the two servers actually
-- hold, not what the checklist claims they hold. That distinction matters here:
-- while investigating buyback access on the same day, E-185 and E-202 both read
-- `☐ ☐` for prod in MIGRATION_CHECKLIST.md while being demonstrably live on
-- database-2. Ticks drift; introspection does not.
--
-- Diff 3 found, in full:
--   · 1 table  only in sandbox : module_usage_user_daily
--   · 3 columns only in sandbox: neodove_campaigns.crm_owner_user_id,
--                                neodove_lead_links.{assigned_owner_id,assigned_at}
--   · 4 indexes only in sandbox: 3 on inventory_upload_reports, 1 on neodove_lead_links
--   · 2 FKs     only in sandbox: nbfc_tenant_id_fkey, field_investigations_agent_fk
--   · 1 column only in PRODUCTION: product_selections.sub_category — deliberately
--     NOT mirrored back. E-103 renamed that column to `model_number` (Sync Audit
--     G-05); prod merely still carries the pre-rename column because these
--     migrations never drop. schema.ts models `model_number` only. Recreating
--     `sub_category` on sandbox would resurrect a retired name.
--
-- ⚠ THIS FILE DELIBERATELY RE-DELIVERS E-237's OBJECTS. The three neodove
-- columns and their partial index are E-237's, and E-237 is applied on database-1
-- but not database-2. It is not simply "run E-237 on prod" because
-- `scripts/apply-e237.mjs` hardcodes `.env.local` (line 25) and `.env.local` IS
-- SANDBOX — that applier cannot reach production at all. Every statement below is
-- IF NOT EXISTS / exception-guarded, so applying this file and E-237 in either
-- order, any number of times, converges on the same state. **When this file is
-- applied to prod, tick E-237's prod box too** — its objects are then live there.
--
-- ⚠ THE TWO FOREIGN KEYS ARE THE ONLY STATEMENTS THAT CAN FAIL ON DATA rather
-- than on schema. `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY` validates
-- every existing row immediately. Both were checked against production on
-- 2026-08-18 before this file was written:
--     nbfc.tenant_id            -> nbfc_tenants(id)   : 8 rows,  0 orphans
--     field_investigations.assigned_agent_id -> nbfc_fi_agents(id) : 16 rows, 0 orphans
-- so both apply cleanly today. They are STILL wrapped in a foreign_key_violation
-- handler, because that count is a snapshot and prod keeps writing: a row added
-- between that check and the apply would otherwise abort the file. On violation
-- the constraint is SKIPPED WITH A NOTICE rather than the migration dying —
-- re-run after cleaning the orphans.
--
-- Strictly additive and idempotent, per CLAUDE.md. No DROP, no type narrowing,
-- no retroactive SET NOT NULL on populated columns.

-- ── module_usage_user_daily ────────────────────────────────────────────────
-- Per-user, per-module, per-day usage rollup. 7 rows on sandbox.
--
-- ⚠ NOTHING IN THE CODEBASE READS OR WRITES THIS TABLE. Verified 2026-08-18 by
-- grepping src/, scripts/ and drizzle/ on this branch AND `git grep` across
-- EVERY remote branch (origin/main, origin/production and all feature branches):
-- zero hits for `module_usage_user_daily` / `moduleUsageUserDaily` outside this
-- file. It has no migration of its own either — it exists on sandbox without any
-- `E-*.sql` having created it, which points at an ad-hoc `db:push` or a hand-run
-- statement. It is created here because the brief was "every table in sandbox
-- must exist in production"; it lands EMPTY and, until something references it,
-- costs prod one empty relation and three empty indexes. If you would rather not
-- carry it, delete this one block — the rest of the file is independent.
--
-- The PK (day, module, user_id) is the grain: one row per user per module per
-- day, which is what makes the writer an upsert rather than an append.
CREATE TABLE IF NOT EXISTS module_usage_user_daily (
    day          date         NOT NULL,
    module       varchar(32)  NOT NULL,
    user_id      uuid         NOT NULL,
    role_at_ping varchar(48),
    role_bucket  varchar(16)  NOT NULL,
    pings        integer      NOT NULL DEFAULT 0,
    sessions     integer      NOT NULL DEFAULT 0,
    last_ping_at timestamptz  NOT NULL DEFAULT now(),
    created_at   timestamptz  NOT NULL DEFAULT now(),
    updated_at   timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT module_usage_user_daily_pkey PRIMARY KEY (day, module, user_id)
);

COMMENT ON TABLE module_usage_user_daily IS
    'Per-user/module/day usage rollup. Created on prod by E-251 to match sandbox. NO CODE REFERENCES IT as of 2026-08-18 (checked across every branch) and no earlier migration creates it.';

-- DESC on the second column of each: every reader of a table like this wants the
-- most recent days first, and a btree scanned backwards for DESC would order the
-- NULLs at the wrong end.
CREATE INDEX IF NOT EXISTS module_usage_user_daily_day_idx
    ON module_usage_user_daily (day);
CREATE INDEX IF NOT EXISTS module_usage_user_daily_module_idx
    ON module_usage_user_daily (module, day DESC);
CREATE INDEX IF NOT EXISTS module_usage_user_daily_user_idx
    ON module_usage_user_daily (user_id, day DESC);

-- ── neodove_campaigns (E-237's column) ─────────────────────────────────────
DO $do$
BEGIN
    ALTER TABLE neodove_campaigns
        ADD COLUMN IF NOT EXISTS crm_owner_user_id text;

    COMMENT ON COLUMN neodove_campaigns.crm_owner_user_id IS
        'users.id::text of the CRM user who should own leads pushed into this campaign - the CRM-side counterpart of the NeoDove campaign-member assignment, which has no API and can be neither read nor written from here. Nothing is ever sent to NeoDove. Read via to_jsonb (see E-237).';
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: neodove_campaigns absent (E-224 not applied here)';
END;
$do$;

-- ── neodove_lead_links (E-237's columns + partial index) ───────────────────
DO $do$
BEGIN
    ALTER TABLE neodove_lead_links
        ADD COLUMN IF NOT EXISTS assigned_owner_id text,
        ADD COLUMN IF NOT EXISTS assigned_at       timestamptz;

    COMMENT ON COLUMN neodove_lead_links.assigned_owner_id IS
        'users.id::text assigned in the CRM as a result of THIS push. Historical: deliberately NOT kept in step with dealer_leads.current_owner_id if the lead is reassigned later.';

    COMMENT ON COLUMN neodove_lead_links.assigned_at IS
        'When the CRM-side assignment for this push landed. NULL = the push carried no assignment, or the assignment failed. Either way the push itself is unaffected.';

    -- Partial: the overwhelming majority of rows come from pushes that carried
    -- no assignment at all.
    CREATE INDEX IF NOT EXISTS neodove_lead_links_assigned_owner_idx
        ON neodove_lead_links (neodove_campaign_id, assigned_owner_id)
        WHERE assigned_owner_id IS NOT NULL;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: neodove_lead_links absent (E-224 not applied here)';
END;
$do$;

-- ── inventory_upload_reports indexes ───────────────────────────────────────
-- The table itself is on both databases (0036); only these three indexes are
-- missing on prod. Index-only: no column is added, changed or dropped, so the
-- worst case of skipping them is a slower query, never a failed one.
DO $do$
BEGIN
    CREATE INDEX IF NOT EXISTS inventory_upload_reports_dealer_idx
        ON inventory_upload_reports (dealer_id);
    CREATE INDEX IF NOT EXISTS inventory_upload_reports_uploaded_by_idx
        ON inventory_upload_reports (uploaded_by);
    CREATE INDEX IF NOT EXISTS inventory_upload_reports_uploaded_at_idx
        ON inventory_upload_reports (uploaded_at);
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: inventory_upload_reports absent';
END;
$do$;

-- ── nbfc.tenant_id -> nbfc_tenants(id) ─────────────────────────────────────
-- Prod on 2026-08-18: 8 rows, 0 orphans.
DO $do$
BEGIN
    ALTER TABLE nbfc
        ADD CONSTRAINT nbfc_tenant_id_fkey
        FOREIGN KEY (tenant_id) REFERENCES nbfc_tenants(id);
EXCEPTION
    WHEN duplicate_object THEN
        RAISE NOTICE 'skip: nbfc_tenant_id_fkey already present';
    WHEN undefined_table OR undefined_column THEN
        RAISE NOTICE 'skip: nbfc / nbfc_tenants / tenant_id absent';
    WHEN foreign_key_violation THEN
        RAISE NOTICE 'SKIPPED nbfc_tenant_id_fkey: rows exist whose tenant_id has no nbfc_tenants row. Nothing else in this file was affected. Clean them, then re-run.';
END;
$do$;

-- ── field_investigations.assigned_agent_id -> nbfc_fi_agents(id) ───────────
-- Prod on 2026-08-18: 16 rows, 0 orphans.
--
-- Added HERE rather than by re-running E-148, which owns this constraint: the
-- 2026-07-25 checklist note records that E-148 was deliberately NOT run whole on
-- database-2 because it rewrites FI state, and only the missing CREATE INDEX was
-- issued from it. Re-running that file now to pick up one constraint would carry
-- the data rewrite with it.
DO $do$
BEGIN
    ALTER TABLE field_investigations
        ADD CONSTRAINT field_investigations_agent_fk
        FOREIGN KEY (assigned_agent_id) REFERENCES nbfc_fi_agents(id);
EXCEPTION
    WHEN duplicate_object THEN
        RAISE NOTICE 'skip: field_investigations_agent_fk already present';
    WHEN undefined_table OR undefined_column THEN
        RAISE NOTICE 'skip: field_investigations / nbfc_fi_agents / assigned_agent_id absent';
    WHEN foreign_key_violation THEN
        RAISE NOTICE 'SKIPPED field_investigations_agent_fk: rows exist whose assigned_agent_id has no nbfc_fi_agents row. Nothing else in this file was affected. Clean them, then re-run.';
END;
$do$;
