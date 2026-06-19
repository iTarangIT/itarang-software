// GET /api/bot/campaigns?page=N&source=bot
//
// Bot command: list recent dialer campaigns so a Discord user can pick one.
// Paginated, newest first. Pass ?source=bot to show only campaigns created
// through the bot (region_filter.source = 'discord-bot').

import { db } from "@/lib/db";
import { dialerCampaigns, users } from "@/lib/db/schema";
import { successResponse } from "@/lib/api-utils";
import { withBotAuth } from "@/lib/bot/auth";
import { BOT_CAMPAIGN_SOURCE } from "@/lib/bot/constants";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";

export const GET = withBotAuth(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const page = Math.max(1, Number(searchParams.get("page") || 1));
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") || 20)));
  const offset = (page - 1) * limit;

  const filters: SQL[] = [];
  const provider = searchParams.get("provider");
  if (provider === "bolna" || provider === "elevenlabs") {
    filters.push(eq(dialerCampaigns.provider, provider));
  }
  if (searchParams.get("source") === "bot") {
    filters.push(
      sql`${dialerCampaigns.region_filter}->>'source' = ${BOT_CAMPAIGN_SOURCE}`,
    );
  }

  const rows = await db
    .select({
      id: dialerCampaigns.id,
      name: dialerCampaigns.name,
      status: dialerCampaigns.status,
      provider: dialerCampaigns.provider,
      totalLeads: dialerCampaigns.total_leads,
      callsMade: dialerCampaigns.calls_made,
      completedLeads: dialerCampaigns.completed_leads,
      failedLeads: dialerCampaigns.failed_leads,
      startedAt: dialerCampaigns.started_at,
      completedAt: dialerCampaigns.completed_at,
      triggeredByName: users.name,
    })
    .from(dialerCampaigns)
    .leftJoin(users, eq(users.id, dialerCampaigns.triggered_by))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(dialerCampaigns.started_at))
    .limit(limit)
    .offset(offset);

  return successResponse({ data: rows, page, pageSize: limit });
});
