-- E-239 — Campaign lead status repair + counter reconcile
--
-- Three data problems on the AI dialer campaign tables, all fixed here.
--
-- 1. status = 'done' rows.
--    'done' is not a status the app knows. The valid set is
--    pending | calling | completed | failed | skipped — the campaign detail
--    API queries each bucket by exact string match, so a 'done' row matches
--    NO bucket and disappears from every tab (All included). Prod campaign
--    camp_msr9dbh0_gwn04wcq had 68 such rows: the header read 71 completed
--    while the table rendered 3. "Done" is only the BADGE LABEL for
--    status='completed' (campaign-status-badge.tsx) — the stored value must
--    be 'completed'.
--
-- 2. dropped_empty calls stored as failures.
--    A dropped_empty AI call connected and produced a transcript; the line
--    just dropped before any qualifying info was captured. E-169 fixed this
--    for the Bolna path, but src/lib/ai/elevenlabs/finalizeCall.ts kept
--    passing success:false, so every ElevenLabs campaign carried on writing
--    red "Failed" rows for calls that actually connected. The code is fixed
--    alongside this migration; this re-runs the E-169 backfill for the rows
--    written since (and for any DB where E-169 was never applied — it is
--    still unticked on all four environments).
--
-- 3. Drifted roll-up counters.
--    dialer_campaigns.completed_leads / failed_leads / calls_made were
--    maintained as ±1 bumps in a second, untransacted statement after each
--    row write. Anything interrupting the process between the pair drifted
--    them permanently and nothing reconciled them. campaignTracker.ts now
--    derives them via syncCampaignCounters(); this restates every existing
--    campaign from its rows so the two agree from here on.
--
-- Data-only (no DDL). Idempotent — a second run flips 0 rows and the counter
-- UPDATE's IS DISTINCT FROM guard matches 0 campaigns. Safe to re-run.
--
-- Run the three statements in order: both status repairs must land before the
-- counters are recomputed, or the recompute bakes in the wrong numbers.

-- 1. 'done' is not a real status — restore it to 'completed'.
UPDATE dialer_campaign_leads
SET status = 'completed'
WHERE status = 'done';

-- 2. E-169 backfill: a dropped_empty call is not a telephony failure.
UPDATE dialer_campaign_leads
SET status = 'completed'
WHERE status = 'failed'
  AND call_outcome = 'dropped_empty';

-- 3. Rebuild every campaign's counters from its rows.
--    calls_made tracks completed_leads by design — it counts calls that
--    actually connected and completed, which is exactly the success path.
WITH t AS (
    SELECT campaign_id,
           count(*) FILTER (WHERE status = 'completed')::int AS comp,
           count(*) FILTER (WHERE status = 'failed')::int    AS fail
    FROM dialer_campaign_leads
    GROUP BY campaign_id
)
UPDATE dialer_campaigns c
SET completed_leads = t.comp,
    failed_leads    = t.fail,
    calls_made      = t.comp
FROM t
WHERE c.id = t.campaign_id
  AND (c.completed_leads, c.failed_leads, c.calls_made)
      IS DISTINCT FROM (t.comp, t.fail, t.comp);
