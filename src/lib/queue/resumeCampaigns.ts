// E-254 — the calling-window ticker: park campaigns whose window has closed,
// wake campaigns whose window has opened.
//
// One implementation, two drivers: the 60s in-process ticker in
// instrumentation-node.ts (what actually runs on the PM2 deployments) and
// /api/cron/campaign-resume (the Vercel-side cron, and a manual handle). They
// had a copy each until this module existed, which meant a test could only ever
// prove one of them.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dialerCampaigns, dialerCampaignLeads } from "@/lib/db/schema";
import { advanceCampaign } from "./advanceCampaign";
import { windowOpenSql } from "./campaignWindow";

export type WindowTickOutcome = {
  /** Campaigns parked because their window closed. */
  parked: string[];
  /** Campaigns claimed because their window opened — already 'running'. */
  resumed: string[];
  /** Of those resumed, the ones that went on to place a call. */
  advanced: string[];
};

/**
 * Park every running campaign whose calling window has closed.
 *
 * WHY THIS EXISTS AT ALL, when advanceCampaign already has the gate.
 *
 * That gate is LAZY: it only fires the next time something calls
 * advanceCampaign, and the only thing that routinely does is a call-completion
 * webhook. A campaign that is between calls when the clock passes its end time
 * has no webhook coming, so nothing parks it.
 *
 * Mostly that is harmless — no call is placed either, so the business-hours
 * guarantee still holds and the campaign parks whenever it is next touched. But
 * two things break:
 *
 *   1. The status LIES. The card says "Running" for a campaign that is not
 *      going to dial again today, which is exactly the question the operator
 *      opened the page to answer.
 *   2. A campaign can get STUCK. advanceCampaign can return without arranging
 *      any re-entry — `max-skips-exceeded` after 100 ineligible leads is the
 *      live example — and the stall watchdog only nudges campaigns when it
 *      actually swept a stalled row. Such a campaign sits in 'running' forever;
 *      and because the resume half below claims 'scheduled', a RECURRING
 *      campaign in that state never wakes again. Not delayed — stuck.
 *
 * So the sweep is what makes "pause at the configured end time" an actual
 * event rather than a side effect of traffic that may not arrive.
 *
 * It parks by calling advanceCampaign rather than writing the pause itself.
 * That keeps one gate in one place: advanceCampaign re-checks the window on the
 * database's clock, decides 'scheduled' vs 'paused' from schedule_mode, and —
 * importantly — still finalizes a campaign whose queue happens to be empty
 * instead of parking a finished run. Duplicating that decision here is how the
 * two copies would drift.
 *
 * A call already in flight is not disturbed. Parking only stops the NEXT call:
 * completeCampaignLead records the in-flight one regardless of campaign status,
 * and its webhook's advanceCampaign then finds a non-running campaign and stops
 * quietly, which is the intended end state.
 */
export async function parkClosedCampaigns(): Promise<string[]> {
  // Only campaigns that are actually mid-run: a 'running' row with nothing
  // pending is a finished campaign waiting for its last webhook, and advancing
  // it here would race that webhook for the finalize.
  const rows = await db
    .select({ id: dialerCampaigns.id })
    .from(dialerCampaigns)
    .where(
      and(
        eq(dialerCampaigns.status, "running"),
        sql`NOT ${windowOpenSql()}`,
        sql`EXISTS (
          SELECT 1 FROM ${dialerCampaignLeads}
           WHERE ${dialerCampaignLeads.campaign_id} = ${dialerCampaigns.id}
             AND ${dialerCampaignLeads.status} = 'pending'
        )`,
      ),
    );

  const parked: string[] = [];
  for (const r of rows) {
    try {
      const res = await advanceCampaign(r.id);
      if (res.kind === "window-closed") parked.push(r.id);
    } catch (err) {
      console.error(
        `[parkClosedCampaigns] park failed for ${r.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return parked;
}

/**
 * Claim every campaign whose window has opened and push each one forward.
 *
 * The claim is a single atomic UPDATE ... RETURNING, not a SELECT followed by
 * an UPDATE. Both drivers can tick in the same second (and PM2 could run more
 * than one instance); with a read-then-write both would see the same due
 * campaign and both would call advanceCampaign, placing two calls to two
 * different leads at once. Here the row matches exactly one statement and the
 * loser gets an empty set.
 *
 * last_advanced_at is stamped in that same statement rather than left to the
 * first placed call, because the stall watchdog measures inactivity from
 * COALESCE(last_advanced_at, started_at). A campaign waking with yesterday's
 * started_at and a NULL last_advanced_at reads as hours-stale on arrival and
 * would be force-stopped before it dialled — every morning.
 */
export async function resumeDueCampaigns(): Promise<{
  resumed: string[];
  advanced: string[];
}> {
  const due = await db.execute<{ id: string }>(sql`
    UPDATE dialer_campaigns
       SET status = 'running',
           resume_after = NULL,
           paused_at = NULL,
           last_advanced_at = now()
     WHERE status = 'scheduled'
       AND resume_after IS NOT NULL
       AND resume_after <= now()
    RETURNING id
  `);

  // drizzle-orm + postgres-js returns .execute() rows as the array directly or
  // under .rows depending on driver. Handle both, as claimNextPending does.
  const rows =
    (due as unknown as { rows?: Array<{ id: string }> }).rows ??
    (due as unknown as Array<{ id: string }>);

  const resumed = rows.map((r) => r.id);
  const advanced: string[] = [];

  for (const id of resumed) {
    try {
      const r = await advanceCampaign(id);
      if (r.kind === "placed") advanced.push(id);
    } catch (err) {
      // One campaign failing to advance must not strand the others claimed in
      // the same tick — they are already 'running' and would otherwise sit with
      // no call in flight until the next watchdog sweep.
      console.error(
        `[resumeDueCampaigns] advance failed for ${id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { resumed, advanced };
}

/**
 * One tick of the calling-window clock. Park first, then resume: the two sets
 * are disjoint (a campaign is either 'running' or 'scheduled'), so the order is
 * not load-bearing, but parking first means a campaign that closes and reopens
 * within the same tick settles on the correct side of the boundary.
 */
export async function runCampaignWindowTick(): Promise<WindowTickOutcome> {
  const parked = await parkClosedCampaigns();
  const { resumed, advanced } = await resumeDueCampaigns();
  return { parked, resumed, advanced };
}
