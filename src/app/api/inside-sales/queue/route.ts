// GET /api/inside-sales/queue?tab=...&page=...&limit=...&q=...&neodove=1
// Paginated rows for one queue tab (BRD §0.5).

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { fetchQueueRows, countQueueRows } from "@/lib/inside-sales/queryBuilder";
import { fetchAssignedByForLeads } from "@/lib/leads/leadAssignedBy";
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
    // Leads who asked to be called back — the AI cannot, so they need a person.
    callback: z.literal("1").optional(),
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
        callback: url.searchParams.get("callback") ?? undefined,
    });
    const neodoveOnly = parsed.neodove === "1";
    const callbackOnly = parsed.callback === "1";

    const [rows, total] = await Promise.all([
        fetchQueueRows({
            tab: parsed.tab,
            userId: user.id,
            page: parsed.page,
            limit: parsed.limit,
            q: parsed.q ?? null,
            neodoveOnly,
            callbackOnly,
        }),
        countQueueRows({
            tab: parsed.tab,
            userId: user.id,
            q: parsed.q ?? null,
            neodoveOnly,
            callbackOnly,
        }),
    ]);

    // Who handed each of this page's leads to its current owner. Decorated in a
    // SEPARATE, fail-tolerant statement rather than joined into the queue query —
    // same pattern and same reason as /api/dealer-leads: the queue is one raw-SQL
    // round trip and a bad join there takes the whole workspace down, whereas a
    // failed decoration just drops the stamp.
    //
    // NOT gated on role. The stamp on /leads is oversight information about other
    // people's leads and is masked accordingly; here it is the recipient being
    // told who sent them the lead, which is the one person who has always had a
    // right to know and was the only one who could not see it.
    const assignedBy = await fetchAssignedByForLeads(
        rows.map((r) => r.id).filter(Boolean),
    );

    const body: QueueResponse = {
        rows: rows.map((r) => ({ ...r, assigned_by: assignedBy[r.id] ?? null })),
        total,
        page: parsed.page,
        limit: parsed.limit,
        tab: parsed.tab,
    };
    return successResponse(body);
});
