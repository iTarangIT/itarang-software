------------------------------------------------------------------------------
-- E-192: buyback scale pack — indexes for 10K+ dealers.
--
-- Three unindexed hot paths, all confirmed by reading the routes they serve:
--   1. src/app/api/admin/buyback/queue/route.ts sorts
--      `ORDER BY br.submitted_at NULLS LAST, br.created_at` on buyback_requests
--      with no supporting index — a full sort of every non-DRAFT request on
--      every queue load.
--   2. src/app/api/admin/buyback/ledger/route.ts filters
--      `WHERE closed_at IS NOT NULL` and sorts `txn_date DESC` on
--      settlement_transactions — same shape, no index.
--   3. src/app/api/admin/buyback/search/route.ts and
--      src/app/api/buyback/search/route.ts do leading-wildcard
--      `ILIKE '%q%'` against request_no / vehicle_no / rc_number /
--      prev_owner_name / leg_sub_id / group_txn_id / txn_ref /
--      business_entity_name / gstin — a leading '%' defeats a plain btree, so
--      these get trigram (pg_trgm) GIN indexes instead.
--   Plus three plain FK indexes (buyback_lines.variant_id, buyback_photos.unit_id,
--   pickups.batch_id) and buyback_activity_log.deal_id, none of which had one.
--
-- *** CREATE EXTENSION pg_trgm REQUIRES rds_superuser. ***
-- On AWS RDS the master/admin user normally holds rds_superuser and this just
-- works; if it does not, statement 1 below fails with "permission denied to
-- create extension" and EVERY trigram (GIN … gin_trgm_ops) index later in this
-- file will then fail too (a different, unhandled error — "operator class
-- gin_trgm_ops does not exist for access method gin" — since that failure mode
-- is not `undefined_table` and is not caught by the guards below). If that
-- happens: re-run `CREATE EXTENSION pg_trgm;` as the RDS master user (or ask
-- someone who has that role), then re-run this whole file — every statement
-- here is idempotent and safe to replay.
--
-- buyback_* tables land together (E-185/186/187) or not at all per env — prod
-- currently has none of them (see drizzle/MIGRATION_CHECKLIST.md). The
-- buyback-table block below is one DO block guarded with
-- `EXCEPTION WHEN undefined_table`, so on prod it no-ops with a single NOTICE
-- instead of erroring out. `accounts` exists on every env (it is not a
-- buyback table), so its two trigram indexes live in their OWN, separate DO
-- block — they must NOT be skipped just because the buyback tables aren't
-- there yet.
--
-- Note on buyback_requests' sort direction: the queue route orders
-- `submitted_at NULLS LAST, created_at` in ascending order (oldest-submitted
-- first — the SLA-aging queue processes the longest-waiting request first).
-- The index below is built ASC/NULLS LAST to match that exactly, which is
-- also Postgres' default for an ascending column — so no explicit DESC here,
-- deliberately.
--
-- Additive + idempotent (CREATE EXTENSION/INDEX IF NOT EXISTS throughout).
-- Re-running this file is a no-op.
------------------------------------------------------------------------------

-- 1. pg_trgm — required by every GIN trigram index below. See warning above.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

------------------------------------------------------------------------------
-- 2. Buyback-table indexes (btree + trigram). No-ops gracefully wherever the
--    buyback_* tables don't exist yet (prod, as of this writing).
------------------------------------------------------------------------------
DO $do$ BEGIN

  -- --- Btree ---------------------------------------------------------------

  -- The review queue's own sort (route.ts: `ORDER BY br.submitted_at NULLS
  -- LAST, br.created_at`), ASC to match — see header note.
  CREATE INDEX IF NOT EXISTS buyback_requests_submitted_created_idx
    ON buyback_requests (submitted_at NULLS LAST, created_at);

  -- buyback_activity_log is already indexed on (request_id, created_at); the
  -- per-deal activity views (e.g. the deal detail timeline) filter on deal_id
  -- alone, which had no index of its own.
  CREATE INDEX IF NOT EXISTS buyback_activity_log_deal_id_idx
    ON buyback_activity_log (deal_id);

  -- The ledger route's own filter+sort (route.ts: `WHERE closed_at IS NOT
  -- NULL … ORDER BY txn_date DESC`). Partial: only closed (settled) legs are
  -- ever queried this way, and open legs would just be dead weight in the index.
  CREATE INDEX IF NOT EXISTS settlement_transactions_txn_date_idx
    ON settlement_transactions (txn_date DESC)
    WHERE closed_at IS NOT NULL;

  -- FK indexes — none of these three had one.
  CREATE INDEX IF NOT EXISTS buyback_lines_variant_id_idx
    ON buyback_lines (variant_id);
  CREATE INDEX IF NOT EXISTS buyback_photos_unit_id_idx
    ON buyback_photos (unit_id);
  CREATE INDEX IF NOT EXISTS pickups_batch_id_idx
    ON pickups (batch_id);

  -- --- GIN trigram (leading-wildcard ILIKE search — M23 / U-search) --------

  CREATE INDEX IF NOT EXISTS buyback_requests_request_no_trgm_idx
    ON buyback_requests USING gin (request_no gin_trgm_ops);

  CREATE INDEX IF NOT EXISTS provenance_records_vehicle_no_trgm_idx
    ON provenance_records USING gin (vehicle_no gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS provenance_records_rc_number_trgm_idx
    ON provenance_records USING gin (rc_number gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS provenance_records_prev_owner_name_trgm_idx
    ON provenance_records USING gin (prev_owner_name gin_trgm_ops);

  CREATE INDEX IF NOT EXISTS settlement_transactions_leg_sub_id_trgm_idx
    ON settlement_transactions USING gin (leg_sub_id gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS settlement_transactions_group_txn_id_trgm_idx
    ON settlement_transactions USING gin (group_txn_id gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS settlement_transactions_txn_ref_trgm_idx
    ON settlement_transactions USING gin (txn_ref gin_trgm_ops);

EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'buyback tables do not exist here yet (E-185/186/187 not applied) — skipping E-192 buyback-table indexes';
END; $do$;

------------------------------------------------------------------------------
-- 3. `accounts` indexes — SEPARATE DO block. `accounts` is not a buyback
--    table and exists on every environment, including prod; it must get its
--    two trigram indexes even where the block above no-ops.
------------------------------------------------------------------------------
DO $do$ BEGIN

  CREATE INDEX IF NOT EXISTS accounts_business_entity_name_trgm_idx
    ON accounts USING gin (business_entity_name gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS accounts_gstin_trgm_idx
    ON accounts USING gin (gstin gin_trgm_ops);

EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'accounts does not exist here (unexpected — it should be present on every env) — skipping E-192 accounts indexes';
END; $do$;
