// GET /api/asm/queue/counts?<filters>
// Badge counts for the 5 ASM tabs in one round trip, plus finalised_not_won —
// the ASM's own "Finalised, not Won" leads on My visits (ID 75.4 chip badge).

import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-utils";
import { ASM_POOL_TABS, claimsByNumberOnly } from "@/lib/leads/claimScope";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { countAsmFinalisedNotWon, fetchAllAsmTabCounts } from "@/lib/asm/queryBuilder";
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
    const [counts, finalisedNotWon] = await Promise.all([
        fetchAllAsmTabCounts(user.id, filters),
        countAsmFinalisedNotWon(user.id),
    ]);
    // ID 45: no pool counts for reps — they claim by number search only.
    if (claimsByNumberOnly(user.role)) {
        for (const t of ASM_POOL_TABS) (counts as Record<string, number>)[t] = 0;
    }
    return successResponse({ ...counts, finalised_not_won: finalisedNotWon });
});
