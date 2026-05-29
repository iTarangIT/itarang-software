// GET /api/admin/leads-info
// Admin-only oversight list of every lead in the inside-sales + ASM pipeline,
// with owner, ASM and latest visit status/outcome. Supports filtering by
// status, owner, ASM, source, region and a free-text search.

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import {
    countLeadsInfoRows,
    fetchLeadsInfoFacets,
    fetchLeadsInfoRows,
    type LeadsInfoFilters,
} from "@/lib/admin/leadsInfoQuery";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(["admin", "sales_head"]);

    const sp = new URL(req.url).searchParams;
    const page = Math.max(1, Number(sp.get("page") ?? "1") || 1);
    const limit = Math.min(100, Math.max(1, Number(sp.get("limit") ?? "25") || 25));

    const filters: LeadsInfoFilters = {
        status: sp.get("status") || null,
        ownerId: sp.get("owner_id") || null,
        asmId: sp.get("asm_id") || null,
        source: sp.get("source") || null,
        state: sp.get("state")?.trim() || null,
        city: sp.get("city")?.trim() || null,
        search: sp.get("search")?.trim() || null,
    };

    const [rows, total, facets] = await Promise.all([
        fetchLeadsInfoRows(filters, page, limit),
        countLeadsInfoRows(filters),
        fetchLeadsInfoFacets(),
    ]);

    return successResponse({ rows, total, page, limit, facets });
});
