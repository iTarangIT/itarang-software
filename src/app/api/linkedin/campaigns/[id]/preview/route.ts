// LinkedIn Outreach — the rendered message for every prospect, with flags.
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";
import { previewCampaign } from "@/lib/linkedin/services/campaigns";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  await requireRole([...LINKEDIN_ROLES]);
  return successResponse(await previewCampaign(id));
});
