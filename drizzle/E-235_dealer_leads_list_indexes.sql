-- E-235: indexes for the merged /leads list.
--
-- WHY
--   "Leads" (/leads) and "Leads Info" (/admin/leads-info) were two screens over
--   the same `dealer_leads` table — same lead, two places to act on it, and each
--   showing half the truth (one filtered on `phone IS NOT NULL`, the other on
--   `is_active IS NOT FALSE`; one showed `current_status`, the other
--   `lead_status`). They are now one list, served by one query builder
--   (src/lib/leads/leadListQuery.ts) behind GET /api/dealer-leads.
--
--   The merged list filters on more columns than either page did alone, and it
--   inherits Leads Info's ordering — `last_touchpoint_at DESC NULLS LAST` — over
--   the full active-lead set rather than the phone-only subset.
--
-- NOT REQUIRED FOR CORRECTNESS
--   Index-only. Nothing is added, narrowed or made NOT NULL, so an unapplied
--   E-235 shows up as latency, never as a "column does not exist" error — unlike
--   E-224. `schema.ts` needs no mirror edit (it does not model these indexes,
--   per E-168 / E-221). Re-running this file is a no-op.
--
-- WHY THE PARTIAL PREDICATE IS `is_active IS NOT FALSE` AND NOT `= true`
--   E-112 already ships `dealer_leads_is_active_idx ... WHERE is_active = true`.
--   That index cannot serve this list. Both the old Leads Info query and the new
--   merged one filter `is_active IS NOT FALSE`, which ALSO admits NULL, and
--   Postgres cannot prove `IS NOT FALSE ⊆ = true`, so it declines the index and
--   falls back to a full scan. Matching the predicate exactly is what makes
--   these usable. (/admin/leads-info has been full-scanning since E-112 for
--   precisely this reason — pre-existing, not introduced here.)
--
-- ALREADY COVERED, DELIBERATELY NOT REPEATED
--   dealer_leads_lead_status_owner_idx (E-112) — the stage filter
--   idx_dealer_leads_state_city        (E-106) — region, once State is a select
--
-- DELIBERATELY NOT INDEXED
--   final_intent_score — the Hot/Warm/Cold stat aggregate scans the whole
--                        filtered set regardless; a btree over a 0–100 int with
--                        four distinct values in practice (0/30/60/90) buys
--                        nothing. If it ever gets slow the answer is a rollup.
--   source             — ~5 distinct values; the planner will seq-scan anyway.
--   state / city       — unusable while those filters are `ILIKE '%…%'`.
--   search             — a 4-column `ILIKE '%…%' OR` is unindexable without
--                        pg_trgm. Pre-existing on both pages; left alone.

-- The list's ORDER BY, over exactly the rows the list selects. This is the one
-- that matters: without it every page is a full scan + sort of the active set.
-- Column order and direction mirror the ORDER BY so Postgres can walk it.
CREATE INDEX IF NOT EXISTS dealer_leads_active_touch_idx
  ON dealer_leads (last_touchpoint_at DESC NULLS LAST, created_at DESC)
  WHERE is_active IS NOT FALSE;

-- The Owner filter and the "Unassigned" stat card (`current_owner_id IS NULL`).
-- dealer_leads_lead_status_owner_idx leads with lead_status, so an owner-only
-- predicate cannot use it.
CREATE INDEX IF NOT EXISTS dealer_leads_active_owner_idx
  ON dealer_leads (current_owner_id)
  WHERE is_active IS NOT FALSE;

-- The created-date range behind the This month / Last month presets.
CREATE INDEX IF NOT EXISTS dealer_leads_active_created_idx
  ON dealer_leads (created_at DESC)
  WHERE is_active IS NOT FALSE;

-- The "All ASMs" filter and its facet. Nothing indexes asm_id anywhere today.
CREATE INDEX IF NOT EXISTS dealer_leads_asm_idx
  ON dealer_leads (asm_id)
  WHERE asm_id IS NOT NULL;
