// GET /api/ai-dialer/campaigns?page=N
// Paginated list of dialer campaigns for the new "Campaigns" tab on /leads.
// Mirrors the GET handler in /api/scraper/run for consistency — same page
// size, same camelCase output shape, same desc(started_at) order.

import { db } from "@/lib/db";
import { dialerCampaigns, users } from "@/lib/db/schema";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { desc, eq } from "drizzle-orm";

export const GET = withErrorHandler(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const page = Math.max(1, Number(searchParams.get("page") || 1));
  const limit = 10;
  const offset = (page - 1) * limit;

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
    })
    .from(dialerCampaigns)
    .leftJoin(users, eq(users.id, dialerCampaigns.triggered_by))
    .orderBy(desc(dialerCampaigns.started_at))
    .limit(limit)
    .offset(offset);

  return successResponse({ data: rows, page });
});
