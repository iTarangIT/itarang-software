// GET /api/ecofy/leads/counts?q=&stage=&temperature=&segment=&assignee=
//
// Tab badge counts for the Ecofy leads list. Takes the SAME filter params as
// the rows so the badges narrow with the table (a cached unfiltered count must
// never sit above a filtered list). `tab` and `page` are read but ignored.

import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_ALL_ROLES } from "@/lib/ecofy/access";
import { readEcofyListParams } from "@/lib/ecofy/listTypes";
import { ecofyListFilterFor, ecofyTabCounts } from "@/lib/ecofy/queries";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: NextRequest) => {
    const user = await requireRole([...ECOFY_ALL_ROLES]);
    const params = readEcofyListParams(new URL(req.url).searchParams);
    // The tab is irrelevant to the counts; "open" keeps a worker's request
    // valid even when their screen is on a tab the helper would refuse.
    const filter = ecofyListFilterFor(user, { ...params, tab: "open" });
    return successResponse(await ecofyTabCounts(filter));
});
