// GET /api/reports/analyses/[id] — Reports › Analyses (Sales Head redesign).
//   lead_sources  ?from&to&group=door|origin|campaign&team&state
//   ai_score      ?from&to&source&team
//   meetings      ?from&to&manager&city
// Dates are inclusive IST days (yyyy-mm-dd). Each result carries its own checks.

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { aiScoreAccuracyByBand, leadSources, meetingsByManagerCity } from "@/lib/reports/analyses";
import { isAnalysisId, LEAD_SOURCE_GROUPS } from "@/lib/reports/analysesShared";

export const dynamic = "force-dynamic";

const READ_ROLES = ["admin", "ceo", "sales_head", "business_head"];
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const Query = z.object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    group: z.enum(LEAD_SOURCE_GROUPS).optional(),
    team: z.enum(["field", "inside"]).optional(),
    state: z.string().trim().max(100).optional(),
    source: z.string().trim().max(40).optional(),
    manager: z.string().trim().max(100).optional(),
    city: z.string().trim().max(100).optional(),
});

export const GET = withErrorHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireRole(READ_ROLES);
    const { id } = await ctx.params;
    if (!isAnalysisId(id)) return errorResponse("Unknown analysis.", 400);

    const raw = Object.fromEntries(
        [...new URL(req.url).searchParams.entries()].filter(([, v]) => v.trim() !== ""),
    );
    const parsed = Query.safeParse(raw);
    if (!parsed.success) return errorResponse("Invalid filters.", 400);
    const f = parsed.data;

    if (id === "lead_sources") return successResponse(await leadSources(f, user));
    if (id === "ai_score") return successResponse(await aiScoreAccuracyByBand(f));
    return successResponse(await meetingsByManagerCity(f));
});
