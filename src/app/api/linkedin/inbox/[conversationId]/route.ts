// LinkedIn Outreach — one thread (opening it marks it read).
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";
import { getThread } from "@/lib/linkedin/services/inbox";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (_req: Request, { params }: { params: Promise<{ conversationId: string }> }) => {
  const { conversationId } = await params;
  await requireRole([...LINKEDIN_ROLES]);
  return successResponse(await getThread(conversationId));
});
