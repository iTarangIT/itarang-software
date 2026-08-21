// GET /api/inside-sales/queue/facets?tab=...
// The State/City options the Inside Sales queue's filter bar offers.
//
// Scoped to the tab for the same reason as the ASM twin: the options should
// describe the list the rep is looking at, not every lead in the database.

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
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

    const regions = await fetchQueueRegions(user.id, parsed.tab);
    return successResponse({ regions });
});
