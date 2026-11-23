// LinkedIn Outreach — a Unipile hosted-login link for this account. The person
// signs in to LinkedIn on Unipile's page; no LinkedIn password or session ever
// reaches the CRM. Unipile then calls /api/webhooks/linkedin/unipile.
import { crmBaseUrl } from "@/lib/assistant/config";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { webhookSecret } from "@/lib/linkedin/credentials";
import { messagingProvider } from "@/lib/linkedin/providers";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";
import { getAccount } from "@/lib/linkedin/services/accounts";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  await requireRole([...LINKEDIN_ROLES]);
  const account = await getAccount(id);
  if (!account) return errorResponse("Account not found", 404);
  const secret = await webhookSecret();
  if (!secret) return errorResponse("APP_SECRETS_ENC_KEY is not set on this server, so the connect callback cannot be secured.", 503);
  const base = crmBaseUrl();
  const url = await messagingProvider(account.provider).connectLink({
    name: account.id,
    notifyUrl: `${base}/api/webhooks/linkedin/unipile?token=${encodeURIComponent(secret)}`,
    successUrl: `${base}/sales-head/linkedin/accounts?connected=${account.id}`,
  });
  return successResponse({ url });
});
