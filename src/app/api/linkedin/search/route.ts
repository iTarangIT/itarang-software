// LinkedIn Outreach — search runs (R1, R2). POST creates a run and returns at
// once; the provider job starts after the response (and the LinkedIn ticker
// retries a run whose start never happened).
import { after } from "next/server";
import { z } from "zod";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";
import { createSearchRun, listRuns, startSearchRun } from "@/lib/linkedin/services/search";

export const dynamic = "force-dynamic";

const Body = z.object({
  keywords: z.string().trim().min(2, "Type at least two characters").max(300),
  location: z.string().trim().max(100).optional().nullable(),
  company: z.string().trim().max(150).optional().nullable(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  account_id: z.string().uuid().optional().nullable(),
});

export const GET = withErrorHandler(async () => {
  await requireRole([...LINKEDIN_ROLES]);
  return successResponse(await listRuns());
});

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireRole([...LINKEDIN_ROLES]);
  const body = Body.parse(await req.json());
  const run = await createSearchRun({
    keywords: body.keywords,
    filters: { location: body.location ?? null, company: body.company ?? null, limit: body.limit ?? 25 },
    accountId: body.account_id ?? null,
    actorId: user.id,
  });
  after(() => startSearchRun(run.id));
  return successResponse(run, 202);
});
