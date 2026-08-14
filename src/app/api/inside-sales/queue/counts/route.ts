// GET /api/inside-sales/queue/counts?neodove=1
// Badge counts for the 5 tabs in one round trip.

import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { fetchAllTabCounts } from "@/lib/inside-sales/queryBuilder";

export const dynamic = "force-dynamic";

const READ_ROLES = [
    "inside_sales_rep",
    "admin",
    "ceo",
    "sales_manager",
    "sales_head",
    "business_head",
];

export const GET = withErrorHandler(async (req: NextRequest) => {
    const user = await requireRole(READ_ROLES);
    // Mirrors the list's own filter, so the badge above a tab and the rows
    // inside it can never disagree about how many leads there are.
    const neodoveOnly =
        new URL(req.url).searchParams.get("neodove") === "1";
    const counts = await fetchAllTabCounts(user.id, { neodoveOnly });
    return successResponse(counts);
});
