// GET /api/asm/queue/counts?<filters>
// Badge counts for the 5 ASM tabs in one round trip, plus finalised_not_won —
// the ASM's own "Finalised, not Won" leads on My visits (ID 75.4 chip badge).

import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-utils";
import { ASM_POOL_TABS, claimsByNumberOnly } from "@/lib/leads/claimScope";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { countAsmFinalisedNotWon, countAsmQueueRows, fetchAllAsmTabCounts } from "@/lib/asm/queryBuilder";
import { hasLeadClocks, pastALimitSql } from "@/lib/leads/clocks";
import { sql } from "drizzle-orm";
import { readAsmQueueFilters } from "@/lib/asm/queueFilterParams";
import { teamForOwnScopedViewer } from "@/lib/users/team";

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
    const sp = new URL(req.url).searchParams;
    const filters = readAsmQueueFilters(sp);
    // 18 Oct row 34 — the "Past a limit" predicate, only where lead_clocks exists.
    const past = (await hasLeadClocks()) ? pastALimitSql(sql`dl.id`) : null;
    const [counts, finalisedNotWon, pastLimitCount] = await Promise.all([
        // ID 155: a manager's own-tab badges include the team, like the table.
        fetchAllAsmTabCounts(user.id, {
            ...filters,
            pastLimit: sp.get("past_limit") === "1" ? (past ?? sql`FALSE`) : null,
            teamMemberIds: await teamForOwnScopedViewer(user),
        }),
        countAsmFinalisedNotWon(user.id),
        past ? countAsmQueueRows({ tab: "my_visits", asmId: user.id, pastLimit: past }).catch(() => 0) : Promise.resolve(0),
    ]);
    // ID 45: no pool counts for reps — they claim by number search only.
    if (claimsByNumberOnly(user.role)) {
        for (const t of ASM_POOL_TABS) (counts as Record<string, number>)[t] = 0;
    }
    return successResponse({ ...counts, finalised_not_won: finalisedNotWon, past_limit: pastLimitCount });
});
