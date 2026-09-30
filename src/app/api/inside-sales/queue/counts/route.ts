// GET /api/inside-sales/queue/counts?neodove=1&callback=1&<filters>
// Badge counts for the 5 tabs in one round trip.

import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-utils";
import { ISR_POOL_TABS, claimsByNumberOnly } from "@/lib/leads/claimScope";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { fetchAllTabCounts } from "@/lib/inside-sales/queryBuilder";
import { readQueueFilters } from "@/lib/leads/queueFilters";

export const dynamic = "force-dynamic";

const READ_ROLES = [
    "inside_sales_rep",
    "admin",
    "ceo",
    "sales_manager",
    "sales_head",
    "business_head",
    "partner",
];

export const GET = withErrorHandler(async (req: NextRequest) => {
    const user = await requireRole(READ_ROLES);
    // Mirrors the list's own filters, so the badge above a tab and the rows
    // inside it can never disagree about how many leads there are.
    const sp = new URL(req.url).searchParams;
    const counts = await fetchAllTabCounts(user.id, {
        neodoveOnly: sp.get("neodove") === "1",
        callbackOnly: sp.get("callback") === "1",
        filters: readQueueFilters(sp),
    });
    // ID 45: no pool counts for reps — they claim by number search only.
    if (claimsByNumberOnly(user.role)) {
        for (const t of ISR_POOL_TABS) (counts as Record<string, number>)[t] = 0;
    }
    return successResponse(counts);
});
