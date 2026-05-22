// GET /api/inside-sales/queue/counts
// Badge counts for the 5 tabs in one round trip.

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

export const GET = withErrorHandler(async () => {
    const user = await requireRole(READ_ROLES);
    const counts = await fetchAllTabCounts(user.id);
    return successResponse(counts);
});
