// GET /api/inside-sales/queue?tab=...&page=...&limit=...&q=...&neodove=1
// Paginated rows for one queue tab (BRD §0.5).

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { fetchQueueRows, countQueueRows } from "@/lib/inside-sales/queryBuilder";
import { QUEUE_TABS, type QueueResponse } from "@/lib/inside-sales/types";

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
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    q: z.string().trim().min(1).max(120).optional(),
    // "1" only. A tri-state (neodove | not_neodove | all) was considered and
    // dropped: "leads NOT with the calling team" is not a question anyone asks,
    // and an absent param already means "all".
    neodove: z.literal("1").optional(),
});

export const GET = withErrorHandler(async (req: NextRequest) => {
    const user = await requireRole(READ_ROLES);
    const url = new URL(req.url);
    const parsed = QuerySchema.parse({
        tab: url.searchParams.get("tab") ?? undefined,
        page: url.searchParams.get("page") ?? undefined,
        limit: url.searchParams.get("limit") ?? undefined,
        q: url.searchParams.get("q") ?? undefined,
        neodove: url.searchParams.get("neodove") ?? undefined,
    });
    const neodoveOnly = parsed.neodove === "1";

    const [rows, total] = await Promise.all([
        fetchQueueRows({
            tab: parsed.tab,
            userId: user.id,
            page: parsed.page,
            limit: parsed.limit,
            q: parsed.q ?? null,
            neodoveOnly,
        }),
        countQueueRows({
            tab: parsed.tab,
            userId: user.id,
            q: parsed.q ?? null,
            neodoveOnly,
        }),
    ]);

    const body: QueueResponse = {
        rows,
        total,
        page: parsed.page,
        limit: parsed.limit,
        tab: parsed.tab,
    };
    return successResponse(body);
});
