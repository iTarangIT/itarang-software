// LinkedIn Outreach — Accounts screen: account status, today's usage against
// caps, pacing settings, Bright Data balance, the action log. POST adds an
// account (then Connect it through Unipile's hosted login).
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { llmConfigured } from "@/lib/linkedin/agent/llm";
import { firecrawlKey } from "@/lib/linkedin/credentials";
import { searchProvider } from "@/lib/linkedin/providers";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";
import { accountsOverview, createAccount } from "@/lib/linkedin/services/accounts";
import { recentLog } from "@/lib/linkedin/services/actionLog";
import { linkedInSendsAllowed } from "@/lib/linkedin/workers/sendTick";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: Request) => {
  await requireRole([...LINKEDIN_ROLES]);
  const sp = new URL(req.url).searchParams;
  const [accounts, log, balance] = await Promise.all([
    accountsOverview(),
    recentLog(sp.get("account") || null, Number(sp.get("log") || 100)),
    searchProvider().balance(),
  ]);
  return successResponse({
    accounts,
    log,
    brightdata_balance: balance,
    environment: {
      sends_allowed: linkedInSendsAllowed(),
      llm_configured: llmConfigured(),
      firecrawl_configured: !!firecrawlKey(),
    },
  });
});

const Body = z.object({ label: z.string().trim().min(1).max(100) });

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireRole([...LINKEDIN_ROLES]);
  const { label } = Body.parse(await req.json());
  return successResponse(await createAccount(label, user.id), 201);
});
