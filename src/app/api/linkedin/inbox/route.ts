// LinkedIn Outreach — conversations, replies first (screen 5).
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";
import { listConversations } from "@/lib/linkedin/services/inbox";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: Request) => {
  await requireRole([...LINKEDIN_ROLES]);
  const accountId = new URL(req.url).searchParams.get("account") || null;
  return successResponse(await listConversations({ accountId }));
});
