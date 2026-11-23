// LinkedIn Outreach — R7: approve a draft. Stores the hashes, freezes every
// rendered message and queues the sendable prospects for the paced worker.
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";
import { approveCampaign } from "@/lib/linkedin/services/campaigns";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const user = await requireRole([...LINKEDIN_ROLES]);
  return successResponse(await approveCampaign(id, user.id));
});
