// LinkedIn Outreach — "stop contacting": do-not-contact across all campaigns.
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";
import { stopContacting } from "@/lib/linkedin/services/inbox";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(async (_req: Request, { params }: { params: Promise<{ conversationId: string }> }) => {
  const { conversationId } = await params;
  const user = await requireRole([...LINKEDIN_ROLES]);
  return successResponse(await stopContacting(conversationId, user.id));
});
