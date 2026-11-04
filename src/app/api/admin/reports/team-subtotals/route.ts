// GET /api/admin/reports/team-subtotals?managers=<id,id>&score=field|inside
//     &from&to&city&state&business_type&granularity
//
// ID 155 — the "Team subtotal" rows of the Sales dashboard scorecard: per
// manager, the team's numbers for the days each member was in the team (the
// Performance › Team total rule). Same readers as the sales dashboard.

import { NextRequest } from "next/server";
import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { parseSalesDashboardParams } from "@/lib/admin/salesDashboard";
import { teamScorecardSubtotals } from "@/lib/admin/teamScorecardSubtotals";

export const dynamic = "force-dynamic";

const READ_ROLES = ["admin", "ceo", "sales_head", "business_head", "partner"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MANAGERS = 40;

export const GET = withErrorHandler(async (req: NextRequest) => {
    await requireRole(READ_ROLES);
    const url = new URL(req.url);

    let params;
    try {
        params = parseSalesDashboardParams(url);
    } catch (e) {
        if (e instanceof z.ZodError) return errorResponse(e.issues[0]?.message ?? "Invalid query.", 400);
        throw e;
    }
    const managers = [...new Set((url.searchParams.get("managers") ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
    if (managers.some((m) => !UUID.test(m))) return errorResponse("managers must be user ids.", 400);
    if (managers.length > MAX_MANAGERS) return errorResponse(`At most ${MAX_MANAGERS} managers.`, 400);
    if (managers.length === 0) return successResponse({});

    const data = await teamScorecardSubtotals(
        managers,
        {
            from: params.from ?? null,
            to: params.to ?? null,
            city: params.city ?? null,
            state: params.state ?? null,
            business_type: params.business_type ?? null,
            granularity: params.granularity,
        },
        { inside: url.searchParams.get("score") === "inside" },
    );
    return successResponse(data);
});
