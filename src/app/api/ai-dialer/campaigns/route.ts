// GET /api/ai-dialer/campaigns?page=N
// Paginated list of dialer campaigns for the new "Campaigns" tab on /leads.
// Mirrors the GET handler in /api/scraper/run for consistency — same page
// size, same camelCase output shape, same desc(started_at) order.

import { db } from "@/lib/db";
import { dialerCampaigns, users } from "@/lib/db/schema";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";

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
      // Total talk time across the campaign's calls (seconds): sum of each
      // call's provider-reported duration (ai_call_logs.call_duration), falling
      // back to per-lead wall-clock (capped at 2h) — mirrors the per-call
      // Duration in the detail table, so this total ≈ the sum of those cells.
      totalTalkTimeSeconds: sql<number>`(
        select coalesce(sum(
          case
            when acl.call_duration is not null and acl.call_duration > 0
              then acl.call_duration
            when dcl.started_at is not null and dcl.completed_at is not null
                 and extract(epoch from (dcl.completed_at - dcl.started_at)) > 0
                 and extract(epoch from (dcl.completed_at - dcl.started_at)) < 7200
              then extract(epoch from (dcl.completed_at - dcl.started_at))::int
            else 0
          end
        ), 0)::int
        from dialer_campaign_leads dcl
        left join ai_call_logs acl on acl.call_id = dcl.bolna_call_id
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
