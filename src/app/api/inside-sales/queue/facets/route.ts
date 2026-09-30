// GET /api/inside-sales/queue/facets?tab=...
// The State/City options the Inside Sales queue's filter bar offers.
//
// Scoped to the tab for the same reason as the ASM twin: the options should
// describe the list the rep is looking at, not every lead in the database.

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { isPoolTabFor } from "@/lib/leads/claimScope";
import { successResponse, withErrorHandler, errorResponse } from "@/lib/api-utils";
import { fetchQueueRegions } from "@/lib/inside-sales/queryBuilder";
import { QUEUE_TABS } from "@/lib/inside-sales/types";

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

const QuerySchema = z.object({
    tab: z.enum(QUEUE_TABS).default("my_open"),
});

export const GET = withErrorHandler(async (req: NextRequest) => {
    const user = await requireRole(READ_ROLES);
    const url = new URL(req.url);
    const parsed = QuerySchema.parse({
        tab: url.searchParams.get("tab") ?? undefined,
    });

    // ID 45: reps never list the unowned pool — they claim by number search.
    if (isPoolTabFor(user.role, parsed.tab)) {
        return errorResponse("Search by mobile number to find and claim a lead.", 403);
    }

    const regions = await fetchQueueRegions(user.id, parsed.tab);
    return successResponse({ regions });
});
