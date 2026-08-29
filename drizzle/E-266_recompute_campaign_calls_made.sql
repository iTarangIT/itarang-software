-- E-266 — Recompute dialer_campaigns.calls_made as ATTEMPTS, not successes.
--
-- NO DDL. Not one column, table, index or constraint. This file exists purely
-- to re-derive a denormalised counter whose DEFINITION changed in
-- src/lib/queue/campaignTracker.ts (syncCampaignCounters).
--
-- WHAT WAS WRONG
--   calls_made was set to completed_leads — the two columns were literally
--   assigned the same expression. Two visible consequences:
--
--     · The campaign detail header rendered "Calls made 71" directly beside
--       "Completed 71" on a 146-lead campaign where 75 leads had in fact been
--       dialled and failed. Two cards, one number, one of them mislabelled.
--
--     · The campaign progress bar is calls_made / total_eligible. A campaign
--       whose leads all fail therefore showed 0% for its entire run AND stayed
--       at 0% after finishing. Sandbox `camp_mpx…` is the standing example:
--       25 leads, 25 failed, status 'completed', progress bar 0%.
--
-- WHY A MIGRATION AND NOT A SCRIPT
--   syncCampaignCounters is a FULL RE-DERIVE fired on every campaign event, so
--   any campaign that will dial again heals itself the moment its next webhook
--   lands. The campaigns that need this file are precisely the ones that will
--   never fire another event — completed, stopped and draft — and those are the
--   ones already on screen being read. Both databases need it, and this file is
--   how this team tracks "both databases got it".
--
-- IDEMPOTENT BY CONSTRUCTION. It is a re-derive, not an increment: running it
-- ten times leaves the same values as running it once, and running it BEFORE
-- the code deploys is equally safe — the new code writes the same expression.
--
-- SAFE TO SKIP AT DEPLOY TIME. Nothing reads a column that does not exist, so
-- an unapplied E-266 is not an outage; it is stale counters on finished
-- campaigns until someone applies it. Contrast E-254, which is REQUIRED.
--
-- Verify (expect zero rows both before-and-after semantics settle):
--   SELECT c.id, c.calls_made, c.completed_leads, c.failed_leads
--     FROM dialer_campaigns c
--    WHERE c.calls_made <> c.completed_leads + c.failed_leads;

BEGIN;

DO $do$
BEGIN
    UPDATE dialer_campaigns c
       SET calls_made      = t.attempted,
           completed_leads = t.comp,
           failed_leads    = t.fail
      FROM (
        SELECT campaign_id,
               count(*) FILTER (WHERE status = 'completed')::int              AS comp,
               count(*) FILTER (WHERE status = 'failed')::int                 AS fail,
               count(*) FILTER (WHERE status IN ('completed', 'failed'))::int AS attempted
          FROM dialer_campaign_leads
         GROUP BY campaign_id
      ) t
     WHERE c.id = t.campaign_id
       -- Touch only the rows that actually disagree, so a re-run updates
       -- nothing and the statement is cheap on a settled database.
       AND (c.calls_made      IS DISTINCT FROM t.attempted
         OR c.completed_leads IS DISTINCT FROM t.comp
         OR c.failed_leads    IS DISTINCT FROM t.fail);

    -- A campaign with no dialer_campaign_leads rows at all is missed by the
    -- join above (a draft that was never populated, or one whose leads were
    -- deleted). Its counters must read zero rather than keep a stale value.
    UPDATE dialer_campaigns c
       SET calls_made = 0, completed_leads = 0, failed_leads = 0
     WHERE NOT EXISTS (
             SELECT 1 FROM dialer_campaign_leads l WHERE l.campaign_id = c.id
           )
       AND (c.calls_made <> 0 OR c.completed_leads <> 0 OR c.failed_leads <> 0);

EXCEPTION
    WHEN undefined_table THEN
        RAISE NOTICE 'skip E-266: dialer_campaigns / dialer_campaign_leads not present';
END;
$do$;

COMMENT ON COLUMN dialer_campaigns.calls_made IS
    'ATTEMPTS: completed_leads + failed_leads. Re-derived in full by '
    'syncCampaignCounters() on every campaign event. Before E-266 this was an '
    'alias of completed_leads, which made the progress bar (calls_made / '
    'total_eligible) read 0% for a campaign whose leads all failed. Cost per '
    'call does NOT divide by this column — cost-analytics counts ai_call_logs '
    'rows itself (cost_calls).';

COMMIT;
