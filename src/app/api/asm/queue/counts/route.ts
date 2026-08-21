// GET /api/asm/queue/counts?<filters>
// Badge counts for the 4 ASM tabs in one round trip.

import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { fetchAllAsmTabCounts } from "@/lib/asm/queryBuilder";
import { readAsmQueueFilters } from "@/lib/asm/queueFilterParams";

export const dynamic = "force-dynamic";

const READ_ROLES = [
    "asm",
    "admin",
    "ceo",
    "sales_manager",
    "sales_head",
    "business_head",
];

export const GET = withErrorHandler(async (req: NextRequest) => {
    const user = await requireRole(READ_ROLES);
    // The same filters the list applies, so a badge and the rows under it can
    // never disagree about how many leads there are.
    const filters = readAsmQueueFilters(new URL(req.url).searchParams);
    const counts = await fetchAllAsmTabCounts(user.id, filters);
    return successResponse(counts);
});
