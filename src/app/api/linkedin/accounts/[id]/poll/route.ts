// LinkedIn Outreach — "Check now": poll this account for acceptances and replies.
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";
import { getAccount, getSettings } from "@/lib/linkedin/services/accounts";
import { pollAccount } from "@/lib/linkedin/workers/pollTick";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  await requireRole([...LINKEDIN_ROLES]);
  const account = await getAccount(id);
  if (!account) return errorResponse("Account not found", 404);
  if (!account.provider_account_id) return errorResponse("Connect the account first", 409);
  if (account.status !== "ok") return errorResponse(`Account is ${account.status}; resume it first`, 409);
  await pollAccount(account, await getSettings(account.id), new Date());
  return successResponse(await getAccount(account.id));
});
