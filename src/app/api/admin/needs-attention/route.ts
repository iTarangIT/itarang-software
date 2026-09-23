// GET /api/admin/needs-attention — the manager's list of idle leads (review
// R-15). Same roles as the bulk-lead route the page reassigns through, so
// nobody sees a list they cannot act on.

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { listNeedsAttention, summarizeNeedsAttention } from "@/lib/leads/needsAttention";

export const dynamic = "force-dynamic";

const VIEW_ROLES = ["admin", "sales_head", "ceo", "partner"];

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(VIEW_ROLES);
    const holder = new URL(req.url).searchParams.get("holder")?.trim() || null;
    // The list is capped for the screen; the totals are not, so the page can
    // say "showing the oldest 500 of 5,234" instead of passing 500 off as all.
    const [rows, holders] = await Promise.all([
        listNeedsAttention({ holderId: holder, limit: 500 }),
        summarizeNeedsAttention({ holderId: holder }),
    ]);
    return successResponse({ rows, holders });
});
