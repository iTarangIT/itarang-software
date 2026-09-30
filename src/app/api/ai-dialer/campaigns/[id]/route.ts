// GET /api/ai-dialer/campaigns/[id]
// Single-campaign detail. Used by the Campaign Detail page header for stats
// cards + region/segment chips + triggered-by name.
//
// statusCounts is the per-status breakdown behind the stat tiles (Completed /
// No Response / Busy / Rejected / Voicemail / Pending / Failed …). Grouped on
// read off idx_dialer_campaign_leads_campaign_status rather than stored as
// counter columns: a new column mirrored in schema.ts would break every reader
// of dialer_campaigns on any database the migration had not reached yet.

import { db } from "@/lib/db";
import { dialerCampaignLeads, dialerCampaigns, users } from "@/lib/db/schema";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { eq, sql } from "drizzle-orm";
import {
  CAMPAIGN_LEAD_STATUSES,
  type CampaignLeadStatus,
} from "@/lib/ai-dialer/campaignLeadStatus";

export const GET = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    if (!id) return errorResponse("Campaign id required", 400);

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
        stoppedBy: dialerCampaigns.stopped_by,
        // E-228/E-254 — the calling window, so the card can say when this
        // campaign runs and when a parked one will wake.
        scheduleMode: dialerCampaigns.schedule_mode,
        windowStart: dialerCampaigns.window_start,
        windowEnd: dialerCampaigns.window_end,
        windowDays: dialerCampaigns.window_days,
        resumeAfter: dialerCampaigns.resume_after,
        pausedAt: dialerCampaigns.paused_at,
        // E-315 — automatic redials per unreached lead (NULL = off).
        maxRetries: dialerCampaigns.max_retries,
      })
      .from(dialerCampaigns)
      .leftJoin(users, eq(users.id, dialerCampaigns.triggered_by))
      .where(eq(dialerCampaigns.id, id))
      .limit(1);

    const campaign = rows[0];
    if (!campaign) return errorResponse("Campaign not found", 404);

    const grouped = await db
      .select({
        status: dialerCampaignLeads.status,
        n: sql<number>`count(*)::int`,
      })
      .from(dialerCampaignLeads)
      .where(eq(dialerCampaignLeads.campaign_id, id))
      .groupBy(dialerCampaignLeads.status);

    const statusCounts = Object.fromEntries(
      CAMPAIGN_LEAD_STATUSES.map((s) => [s, 0]),
    ) as Record<CampaignLeadStatus, number>;
    for (const g of grouped) {
      if (g.status in statusCounts) {
        statusCounts[g.status as CampaignLeadStatus] = Number(g.n);
      }
    }

    // E-315 — auto-retry progress: how many unreached leads have a redial
    // booked, when the next one goes out, and total dials incl. retries.
    const retryRows = await db
      .select({
        retryScheduled: sql<number>`count(*) FILTER (WHERE ${dialerCampaignLeads.next_attempt_at} IS NOT NULL)::int`,
        nextRetryAt: sql<string | null>`min(${dialerCampaignLeads.next_attempt_at})`,
        totalDials: sql<number>`coalesce(sum(${dialerCampaignLeads.attempt_count}), 0)::int`,
      })
      .from(dialerCampaignLeads)
      .where(eq(dialerCampaignLeads.campaign_id, id));
    const retry = retryRows[0];

    return successResponse({
      ...campaign,
      statusCounts,
      retryScheduled: Number(retry?.retryScheduled ?? 0),
      nextRetryAt: retry?.nextRetryAt ? new Date(retry.nextRetryAt).toISOString() : null,
      totalDials: Number(retry?.totalDials ?? 0),
    });
  },
);
