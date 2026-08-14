// GET /api/asm/queue?tab=...&page=...&limit=...&q=...
// Paginated rows for one ASM queue tab (BRD §0.8).

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { fetchAsmQueueRows, countAsmQueueRows } from "@/lib/asm/queryBuilder";
import { fetchAssignedByForLeads } from "@/lib/leads/leadAssignedBy";
import { ASM_QUEUE_TABS, type AsmQueueResponse } from "@/lib/asm/types";

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
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    q: z.string().trim().min(1).max(120).optional(),
});

export const GET = withErrorHandler(async (req: NextRequest) => {
    const user = await requireRole(READ_ROLES);
    const url = new URL(req.url);
    const parsed = QuerySchema.parse({
        tab: url.searchParams.get("tab") ?? undefined,
        page: url.searchParams.get("page") ?? undefined,
        limit: url.searchParams.get("limit") ?? undefined,
        q: url.searchParams.get("q") ?? undefined,
    });

    const [rows, total] = await Promise.all([
        fetchAsmQueueRows({
            tab: parsed.tab,
            asmId: user.id,
            page: parsed.page,
            limit: parsed.limit,
            q: parsed.q ?? null,
        }),
        countAsmQueueRows({ tab: parsed.tab, asmId: user.id, q: parsed.q ?? null }),
    ]);

    // Who handed each lead over — decorated separately and fail-tolerantly, same
    // as the inside-sales queue. An ASM transfer writes `asm_transfer`, which is
    // one of the three touchpoint types this reads, so a lead pushed down by the
    // CEO or a rep is stamped with whoever pushed it.
    const assignedBy = await fetchAssignedByForLeads(
        rows.map((r) => r.id).filter(Boolean),
    );

    const body: AsmQueueResponse = {
        rows: rows.map((r) => ({ ...r, assigned_by: assignedBy[r.id] ?? null })),
        total,
        page: parsed.page,
        limit: parsed.limit,
        tab: parsed.tab,
    };
    return successResponse(body);
});
