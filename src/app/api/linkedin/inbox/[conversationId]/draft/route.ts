// LinkedIn Outreach — agent-drafted reply suggestion. Never sent on its own.
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";
import { draftFor } from "@/lib/linkedin/services/inbox";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(async (_req: Request, { params }: { params: Promise<{ conversationId: string }> }) => {
  const { conversationId } = await params;
  await requireRole([...LINKEDIN_ROLES]);
  return successResponse(await draftFor(conversationId));
});
