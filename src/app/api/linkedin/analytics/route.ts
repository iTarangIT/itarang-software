// LinkedIn Outreach — campaign analytics by category (E-398):
// Approached → Accepted → Replied → Meeting scheduled.
//   GET ?from=YYYY-MM-DD&to=YYYY-MM-DD&category=&account_id=&campaign_id=&status=
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";
import { analytics } from "@/lib/linkedin/services/analytics";

export const dynamic = "force-dynamic";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable();
const AnalyticsQuery = z.object({
  from: date,
  to: date,
  category: z.string().trim().max(24).optional().nullable(),
  account_id: z.string().uuid().optional().nullable(),
  campaign_id: z.string().uuid().optional().nullable(),
  status: z.string().trim().max(12).optional().nullable(),
});

export const GET = withErrorHandler(async (req: Request) => {
  await requireRole([...LINKEDIN_ROLES]);
  const sp = new URL(req.url).searchParams;
  const q = AnalyticsQuery.parse(Object.fromEntries([...sp.entries()].filter(([, v]) => v !== "")));
  return successResponse(
    await analytics({
      from: q.from,
      to: q.to,
      category: q.category,
      accountId: q.account_id,
      campaignId: q.campaign_id,
      status: q.status,
    }),
  );
});
