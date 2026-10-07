// GET /api/admin/needs-attention — the manager's list of idle leads (review
// R-15). Same roles as the bulk-lead route the page reassigns through, so
// nobody sees a list they cannot act on.
//
// ?format=csv downloads the list with the page's filters (holder, q, role,
// status, interest, min_days — needsAttentionFilter.ts), so the file is
// exactly the rows on screen.

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { listNeedsAttention, summarizeNeedsAttention } from "@/lib/leads/needsAttention";
import { filterNeedsAttention, needsAttentionFiltersFrom } from "@/lib/leads/needsAttentionFilter";
import { csvDateTime, csvResponse } from "@/lib/leads/queueCsv";
import { LEAD_STATUS_LABEL } from "@/lib/leads/queueFilters";

export const dynamic = "force-dynamic";

const VIEW_ROLES = ["admin", "sales_head", "ceo", "partner"];
// listNeedsAttention's own ceiling. The page filters on the client, so it loads
// as much as the query allows; the totals below are never capped.
const MAX_ROWS = 2000;

const statusLabel = (s: string | null) =>
    (s && (LEAD_STATUS_LABEL as Record<string, string>)[s]) || (s ?? "").replace(/_/g, " ");

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(VIEW_ROLES);
    const p = new URL(req.url).searchParams;
    const holder = p.get("holder")?.trim() || null;

    if (p.get("format") === "csv") {
        const all = await listNeedsAttention({ holderId: holder, limit: MAX_ROWS });
        const rows = filterNeedsAttention(all, needsAttentionFiltersFrom(p));
        return csvResponse({
            rows,
            filename: "needs-attention",
            total: rows.length,
            columns: [
                { header: "Lead ID", value: (r) => r.lead_id },
                { header: "Dealer", value: (r) => r.dealer },
                { header: "City", value: (r) => r.city ?? "" },
                { header: "Held by", value: (r) => r.holder_name ?? "" },
                { header: "Role", value: (r) => (r.holder_role ?? "").replace(/_/g, " ") },
                { header: "Status", value: (r) => statusLabel(r.lead_status) },
                { header: "Interest", value: (r) => r.interest_level ?? "" },
                { header: "Working days idle", value: (r) => String(r.days_idle) },
                { header: "Last worked", value: (r) => csvDateTime(r.last_worked_at) || "never" },
                { header: "Last disposition", value: (r) => r.last_disposition ?? "" },
                { header: "Non-responsive", value: (r) => (r.non_responsive ? "Yes" : "") },
                { header: "Field visit overdue", value: (r) => (r.visit_overdue ? "Yes" : "") },
            ],
        });
    }

    // The list is capped for the screen; the totals are not, so the page can
    // say "showing the oldest 2,000 of 5,234" instead of passing 2,000 off as all.
    const [rows, holders] = await Promise.all([
        listNeedsAttention({ holderId: holder, limit: MAX_ROWS }),
        summarizeNeedsAttention({ holderId: holder }),
    ]);
    return successResponse({ rows, holders });
});
