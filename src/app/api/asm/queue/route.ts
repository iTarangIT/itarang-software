// GET /api/asm/queue?tab=...&page=...&limit=...&q=...&<filters>
// Paginated rows for one ASM queue tab (BRD §0.8).
// &ids_only=1 returns just the first `limit` ids in queue order (≤ BULK_CLAIM_CAP)
// — feeds "Select first N" on the Unclaimed tab's bulk-claim bar (B3).
//
// The filter params are parsed by readAsmQueueFilters, shared with the counts,
// facets and CSV-export routes so all four can never disagree about what the
// user asked for.

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { fetchAsmQueueRows, countAsmQueueRows, fetchAsmQueueIds } from "@/lib/asm/queryBuilder";
import { BULK_CLAIM_CAP } from "@/lib/inside-sales/types";
import { fetchAssignedByForLeads } from "@/lib/leads/leadAssignedBy";
import { fetchBusinessTypeForLeads } from "@/lib/leads/leadListQuery";
import { ASM_QUEUE_TABS, type AsmQueueResponse } from "@/lib/asm/types";
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

const QuerySchema = z.object({
    tab: z.enum(ASM_QUEUE_TABS).default("my_visits"),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    q: z.string().trim().min(1).max(120).optional(),
    ids_only: z.literal("1").optional(),
});

export const GET = withErrorHandler(async (req: NextRequest) => {
    const user = await requireRole(READ_ROLES);
    const url = new URL(req.url);
    const parsed = QuerySchema.parse({
        tab: url.searchParams.get("tab") ?? undefined,
        page: url.searchParams.get("page") ?? undefined,
        limit: url.searchParams.get("limit") ?? undefined,
        q: url.searchParams.get("q") ?? undefined,
        ids_only: url.searchParams.get("ids_only") ?? undefined,
    });

    const filters = readAsmQueueFilters(url.searchParams);

    if (parsed.ids_only === "1") {
        const ids = await fetchAsmQueueIds({
            tab: parsed.tab,
            asmId: user.id,
            limit: Math.min(parsed.limit, BULK_CLAIM_CAP),
            q: parsed.q ?? null,
            ...filters,
        });
        return successResponse({ ids, cap: BULK_CLAIM_CAP });
    }

    const [rows, total] = await Promise.all([
        fetchAsmQueueRows({
            tab: parsed.tab,
            asmId: user.id,
            page: parsed.page,
            limit: parsed.limit,
            q: parsed.q ?? null,
            ...filters,
        }),
        countAsmQueueRows({
            tab: parsed.tab,
            asmId: user.id,
            q: parsed.q ?? null,
            ...filters,
        }),
    ]);

    // Who handed each lead over — decorated separately and fail-tolerantly, same
    // as the inside-sales queue. An ASM transfer writes `asm_transfer`, which is
    // one of the three touchpoint types this reads, so a lead pushed down by the
    // CEO or a rep is stamped with whoever pushed it.
    const ids = rows.map((r) => r.id).filter(Boolean);
    const [assignedBy, businessTypes] = await Promise.all([
        fetchAssignedByForLeads(ids),
        // E-296 business_type — same separate, fail-tolerant decoration as the
        // inside-sales queue: a database without the column shows "Not set".
        fetchBusinessTypeForLeads(ids),
    ]);

    const body: AsmQueueResponse = {
        rows: rows.map((r) => ({
            ...r,
            assigned_by: assignedBy[r.id] ?? null,
            business_type: businessTypes[r.id] ?? null,
        })),
        total,
        page: parsed.page,
        limit: parsed.limit,
        tab: parsed.tab,
    };
    return successResponse(body);
});
