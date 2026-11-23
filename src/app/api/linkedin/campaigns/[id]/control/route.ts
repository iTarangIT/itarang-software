// LinkedIn Outreach — pause / resume / stop a campaign.
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";
import { setCampaignStatus } from "@/lib/linkedin/services/campaigns";

export const dynamic = "force-dynamic";

const Body = z.object({ action: z.enum(["pause", "resume", "stop"]) });

export const POST = withErrorHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const user = await requireRole([...LINKEDIN_ROLES]);
  const { action } = Body.parse(await req.json());
  return successResponse(await setCampaignStatus(id, action, user.id));
});
