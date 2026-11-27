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
  country: z.string().trim().max(60).optional().nullable(),
  state: z.string().trim().max(60).optional().nullable(),
  city: z.string().trim().max(80).optional().nullable(),
  title: z.string().trim().max(120).optional().nullable(),
  industry: z.string().trim().max(120).optional().nullable(),
  exclude: z.string().trim().max(200).optional().nullable(),
  match: z.enum(["broad", "strict"]).optional().nullable(),
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
    filters: {
      location: body.location || null,
      company: body.company || null,
      country: body.country || null,
      state: body.state || null,
      city: body.city || null,
      title: body.title || null,
      industry: body.industry || null,
      exclude: body.exclude || null,
      match: body.match ?? "broad",
      limit: body.limit ?? 25,
    },
    accountId: body.account_id ?? null,
    actorId: user.id,
  });
  after(() => startSearchRun(run.id));
  return successResponse(run, 202);
});
