-- E-169 — Campaign "dropped_empty" calls are not failures
--
-- A dropped_empty AI call connected and produced a transcript — the line just
-- dropped before any qualifying info was captured. It was wrongly finalized as
-- a failure (dialer_campaign_leads.status = 'failed'), so the campaign results
-- table showed a red "Failed" badge for calls that actually connected.
--
-- The code path is fixed going forward (finalizeCall.ts now marks dropped_empty
-- as success → status 'completed' → blue "Done"). This migration backfills the
-- already-stored rows and reconciles each campaign's roll-up counters so the
-- historical campaigns render correctly too.
--
-- Data-only (no DDL). Idempotent — a second run flips 0 rows (none remain with
-- status='failed' AND call_outcome='dropped_empty'), so the counter update
-- touches 0 campaigns. GREATEST(...,0) guards against pre-existing counter drift.

WITH flipped AS (
    UPDATE dialer_campaign_leads
    SET status = 'completed'
    WHERE status = 'failed' AND call_outcome = 'dropped_empty'
    RETURNING campaign_id
),
agg AS (
    SELECT campaign_id, COUNT(*)::int AS k
    FROM flipped
    GROUP BY campaign_id
)
UPDATE dialer_campaigns c
SET failed_leads    = GREATEST(c.failed_leads - agg.k, 0),
    completed_leads = c.completed_leads + agg.k,
    calls_made      = c.calls_made + agg.k
FROM agg
WHERE c.id = agg.campaign_id;
