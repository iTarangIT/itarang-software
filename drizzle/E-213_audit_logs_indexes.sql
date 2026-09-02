------------------------------------------------------------------------------
-- E-213 — indexes on audit_logs.
--
-- audit_logs has carried ZERO indexes since it was created (0000_*.sql). It is
-- one of the CRM's largest write-log tables — ~53 API routes and services
-- INSERT into it — and three separate surfaces read it on a hot path:
--
--   1. /operations/team renders THREE 30-day scans per render
--      (src/lib/operations/team.ts:76-107): actions by role, top actors, and
--      the total. That page carries <AutoRefresh intervalMs={60_000} />, so
--      those three sequential scans run once a minute, per open tab, forever.
--   2. The `team.rollup` collector runs a fourth (`team.actions_24h`) hourly.
--   3. /api/audit-log filters by performed_by, entity_id and entity_type
--      (src/app/api/audit-log/route.ts:151-165) for the NBFC compliance viewer.
--
-- Every one of those is a sequential scan today.
--
--   created_at DESC              — the shape all four time-bounded aggregates
--                                  use (`created_at > NOW() - INTERVAL 'N days'`).
--   (performed_by, created_at)   — the per-actor lookup: equality column first,
--                                  ordered column second so a per-user history
--                                  needs no sort. Also serves the upcoming
--                                  /operations/usage read path.
--   (entity_type, entity_id)     — the compliance viewer's exact-match filters.
--
-- NOT indexed: `timestamp`. The table carries both `created_at` and `timestamp`
-- (a historical duplication), but every query in src/ filters on created_at.
-- Indexing an unread column costs write throughput for nothing.
--
-- CONCURRENTLY is deliberately NOT used: it cannot run inside a DO block or any
-- transaction. On a very large audit_logs the ACCESS EXCLUSIVE lock these take
-- may be unacceptable on prod — in that case run the three CREATE INDEX
-- statements standalone, outside this block, with CONCURRENTLY added, and tick
-- the checklist as normal. The index names are identical either way, so the
-- IF NOT EXISTS here turns this file into a no-op afterwards.
--
-- Index-only. No schema.ts change — same reasoning as E-211: adding an index
-- callback to the auditLogs table would imply a column change that does not
-- exist. Strictly additive. Re-running this file is a no-op.
------------------------------------------------------------------------------

-- The COMMENTs live inside the block: if the table is absent the CREATEs are
-- skipped, and a COMMENT on an index that was never created would then fail
-- outside the handler's reach. Same structure as E-211.
DO $do$ BEGIN
  CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx
    ON audit_logs (created_at DESC);

  CREATE INDEX IF NOT EXISTS audit_logs_performed_by_created_idx
    ON audit_logs (performed_by, created_at DESC);

  CREATE INDEX IF NOT EXISTS audit_logs_entity_idx
    ON audit_logs (entity_type, entity_id);

  COMMENT ON INDEX audit_logs_created_at_idx IS
    'E-213 — every /operations/team and /operations/usage aggregate is time-bounded on created_at.';
  COMMENT ON INDEX audit_logs_performed_by_created_idx IS
    'E-213 — per-actor history: equality on performed_by, then ordered by created_at without a sort.';
  COMMENT ON INDEX audit_logs_entity_idx IS
    'E-213 — the entity_type/entity_id exact-match filters behind /api/audit-log.';
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'skip audit_logs — table not present';
END; $do$;
