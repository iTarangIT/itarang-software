// GET /api/asm/queue/facets?tab=...
// The State/City options the ASM queue's filter bar offers.
//
// SCOPED TO THE TAB, not to the whole lead table: an ASM offered every state in
// the country would spend most clicks discovering that their queue has nothing
// there. Territory Feed spans a region, My Closed spans far less, and the
// options should say so.

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { fetchAsmQueueRegions } from "@/lib/asm/queryBuilder";
import { ASM_QUEUE_TABS } from "@/lib/asm/types";

export const dynamic = "force-dynamic";

const READ_ROLES = [
    "asm",
    "admin",
    "ceo",
    "sales_manager",
    "sales_head",
    "business_head",
];

const QuerySchema = z.object({
    tab: z.enum(ASM_QUEUE_TABS).default("my_visits"),
});

export const GET = withErrorHandler(async (req: NextRequest) => {
    const user = await requireRole(READ_ROLES);
    const url = new URL(req.url);
    const parsed = QuerySchema.parse({
        tab: url.searchParams.get("tab") ?? undefined,
    });

    const regions = await fetchAsmQueueRegions(user.id, parsed.tab);
    return successResponse({ regions });
});
