// GET /api/asm/queue/counts
// Badge counts for the 4 ASM tabs in one round trip.

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { fetchAllAsmTabCounts } from "@/lib/asm/queryBuilder";

export const dynamic = "force-dynamic";

const READ_ROLES = [
    "asm",
    "admin",
    "ceo",
    "sales_manager",
    "sales_head",
    "business_head",
];

export const GET = withErrorHandler(async () => {
    const user = await requireRole(READ_ROLES);
    const counts = await fetchAllAsmTabCounts(user.id);
    return successResponse(counts);
});
