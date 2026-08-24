// GET /api/ai-dialer/campaigns?page=N
// Paginated list of dialer campaigns for the new "Campaigns" tab on /leads.
// Mirrors the GET handler in /api/scraper/run for consistency — same page
// size, same camelCase output shape, same desc(started_at) order.

import { db } from "@/lib/db";
import { dialerCampaigns, users } from "@/lib/db/schema";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { DURATION_SECONDS_SQL } from "@/lib/ai-dialer/call-duration/derive";

export const GET = withErrorHandler(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const page = Math.max(1, Number(searchParams.get("page") || 1));
  // Default 10 keeps the existing CampaignsTable pagination unchanged.
  // Cost Analytics dropdown opts in to a larger limit (capped at 200).
  const limit = Math.min(200, Math.max(1, Number(searchParams.get("limit") || 10)));
  const offset = (page - 1) * limit;

  // Optional provider filter for the Cost Analytics campaign picker.
  const provider = searchParams.get("provider");
  const filters: SQL[] = [];
  if (provider === "bolna" || provider === "elevenlabs") {
    filters.push(eq(dialerCampaigns.provider, provider));
  }

  // The Lists tab opts in with ?kind=list to show only list-origin campaigns
  // (drafts + running + done). Region campaigns have no `kind` key in their
  // region_filter blob, so ->>'kind' is NULL and they're excluded.
  if (searchParams.get("kind") === "list") {
    filters.push(sql`${dialerCampaigns.region_filter}->>'kind' = 'list'`);
  }

  const rows = await db
    .select({
      id: dialerCampaigns.id,
      name: dialerCampaigns.name,
      status: dialerCampaigns.status,
      provider: dialerCampaigns.provider,
      category: dialerCampaigns.category,
      regionFilter: dialerCampaigns.region_filter,
      totalLeads: dialerCampaigns.total_leads,
      callsMade: dialerCampaigns.calls_made,
      completedLeads: dialerCampaigns.completed_leads,
      failedLeads: dialerCampaigns.failed_leads,
      startedAt: dialerCampaigns.started_at,
      completedAt: dialerCampaigns.completed_at,
      triggeredBy: dialerCampaigns.triggered_by,
      triggeredByName: users.name,
      // E-228/E-254 — the calling window, so the card can say when this
      // campaign runs and when a parked one will wake.
      scheduleMode: dialerCampaigns.schedule_mode,
      windowStart: dialerCampaigns.window_start,
      windowEnd: dialerCampaigns.window_end,
      windowDays: dialerCampaigns.window_days,
      resumeAfter: dialerCampaigns.resume_after,
      pausedAt: dialerCampaigns.paused_at,
      // Total talk time across the campaign's calls (seconds). Binds the ONE
      // duration rule from call-duration/derive rather than restating it, which
      // is what makes the claim below true: this total IS the sum of the
      // per-call Duration cells in the detail table, not an approximation of
      // them. The local copy this replaces accepted per-lead wall clock on its
      // own, so it was adding the seconds the dialer spent failing to place
      // trigger_failed calls to a figure labelled "talk time".
      //
      // LATERAL ... LIMIT 1, not a plain LEFT JOIN: ai_call_logs_call_id_idx is
      // NOT unique, and a lead whose call_id has two log rows was having its
      // duration counted twice by the join this replaces.
      //
      // coalesce(..., 0) restores the summing behaviour the predicate itself
      // deliberately drops — it yields NULL for "we were never told", which a
      // histogram needs to distinguish and a SUM does not.
      totalTalkTimeSeconds: sql<number>`(
        select coalesce(sum(coalesce(${DURATION_SECONDS_SQL}, 0)), 0)::int
        from dialer_campaign_leads dcl
        left join lateral (
          select a.call_duration, a.transcript
            from ai_call_logs a
           where a.call_id = dcl.bolna_call_id
           order by a.updated_at desc nulls last
           limit 1
        ) acl on true
        where dcl.campaign_id = ${dialerCampaigns.id}
      )`,
    })
    .from(dialerCampaigns)
    .leftJoin(users, eq(users.id, dialerCampaigns.triggered_by))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(dialerCampaigns.started_at))
    .limit(limit)
    .offset(offset);

  return successResponse({ data: rows, page });
});
