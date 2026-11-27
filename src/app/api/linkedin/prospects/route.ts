// LinkedIn Outreach — all prospects, with filters (screen 2).
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";
import { listProspects } from "@/lib/linkedin/services/prospects";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: Request) => {
  await requireRole([...LINKEDIN_ROLES]);
  const sp = new URL(req.url).searchParams;
  return successResponse(
    await listProspects({
      runId: sp.get("run") || null,
      state: sp.get("state") || null,
      company: sp.get("company") || null,
      city: sp.get("city") || null,
      title: sp.get("title") || null,
      q: sp.get("q") || null,
      page: Number(sp.get("page") || 1),
      pageSize: Number(sp.get("pageSize") || 50),
    }),
  );
});
