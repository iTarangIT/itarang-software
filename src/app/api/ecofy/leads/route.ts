// GET /api/ecofy/leads?tab=&q=&stage=&temperature=&segment=&assignee=&page=&limit=
//
// One page of the Ecofy leads list (E-307 list redesign). Local ecofy_leads
// mirror only — never calls Ecofy, so the list is as fast as any CRM queue.
// Workers (ASM / ISR) are pinned to their own leads; the pickup queue is the
// Sales Head's alone (403 otherwise).

import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_ALL_ROLES } from "@/lib/ecofy/access";
import { readEcofyListParams, type EcofyListResponse } from "@/lib/ecofy/listTypes";
import { EcofyForbiddenError, ecofyListFilterFor, listEcofyLeadsPage, toEcofyListRow } from "@/lib/ecofy/queries";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: NextRequest) => {
    const user = await requireRole([...ECOFY_ALL_ROLES]);
    const params = readEcofyListParams(new URL(req.url).searchParams);
    let filter;
    try {
        filter = ecofyListFilterFor(user, params);
    } catch (e) {
        if (e instanceof EcofyForbiddenError) return errorResponse(e.message, 403);
        throw e;
    }
    const { rows, total } = await listEcofyLeadsPage(filter);
    const body: EcofyListResponse = { rows: rows.map(toEcofyListRow), total, page: params.page, limit: params.limit };
    return successResponse(body);
});
