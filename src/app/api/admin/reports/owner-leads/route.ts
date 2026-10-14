// GET /api/admin/reports/owner-leads?person_id=&metric=&date_from=&date_to=
// Funnel-by-Owner drill-down: the leads behind one clicked cell. Same role gate
// and date filters as the report itself (../[type]/route.ts).
//
//   ?person_id=<id>             one person's leads (the popup) — first 500
//   ?person_ids=<id>,<id>,…     several people (a column, as on screen)
//   ?format=csv                 the CSV of every matching lead (up to 20,000),
//                               one row per (person, lead) with full details —
//                               the Sales dashboard's per-column download.
//                               person_id(s) optional: none = everyone.

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import {
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";
import { funnelByOwnerLeads, ownerMetricLeads } from "@/lib/admin/reports";
import { parseDashboardFilters } from "@/lib/admin/filters";
import { OWNER_DRILL_METRICS, type OwnerDrillLead } from "@/lib/admin/types";
import { csvDateTime, csvResponse } from "@/lib/leads/queueCsv";
import { LEAD_STATUS_LABEL } from "@/lib/leads/queueFilters";

export const dynamic = "force-dynamic";

const READ_ROLES = ["admin", "sales_head", "ceo", "partner"];
const CSV_MAX = 20000;
const Metric = z.enum(OWNER_DRILL_METRICS);

const METRIC_FILE: Record<string, string> = {
    owned_open: "open-leads-owned",
    not_worked: "not-worked",
    touched: "leads-touched",
    connected: "connected",
    hot: "hot",
    warm: "warm",
    cold: "cold",
    ai_qualified: "ai-qualified",
    ai_warm: "ai-warm",
    ai_cold: "ai-cold",
    converted: "converted",
};

const pretty = (v: string | null | undefined) => (v ? v.replace(/_/g, " ") : "");

export const GET = withErrorHandler(async (req: NextRequest) => {
    await requireRole(READ_ROLES);
    const url = new URL(req.url);
    const metric = Metric.safeParse(url.searchParams.get("metric"));
    if (!metric.success) return errorResponse("Invalid metric.", 400);
    const filters = parseDashboardFilters(url);

    if (url.searchParams.get("format") === "csv") {
        const ids = [
            ...(url.searchParams.get("person_ids") ?? "").split(","),
            url.searchParams.get("person_id") ?? "",
        ]
            .map((s) => s.trim())
            .filter((s) => s.length > 0 && s.length <= 100)
            .slice(0, 500);
        // One past the cap, so a truncated file says so (X-Export-Truncated).
        const rows = await ownerMetricLeads(metric.data, filters, { personIds: ids.length ? ids : null, limit: CSV_MAX + 1 });
        return csvResponse<OwnerDrillLead>({
            rows: rows.slice(0, CSV_MAX),
            total: rows.length,
            filename: `${METRIC_FILE[metric.data] ?? metric.data}-by-person`,
            columns: [
                { header: "Person (counted for)", value: (r) => r.person_name ?? r.person_id ?? "" },
                { header: "Lead ID", value: (r) => r.id },
                { header: "Shop", value: (r) => r.shop_name ?? "" },
                { header: "Dealer", value: (r) => r.dealer_name ?? "" },
                { header: "Phone", value: (r) => r.phone ?? "" },
                { header: "City", value: (r) => r.city ?? "" },
                { header: "State", value: (r) => r.state ?? "" },
                { header: "Area", value: (r) => r.area ?? "" },
                { header: "Pincode", value: (r) => r.pincode ?? "" },
                { header: "Status", value: (r) => (r.lead_status && (LEAD_STATUS_LABEL as Record<string, string>)[r.lead_status]) || pretty(r.lead_status) },
                { header: "Rating", value: (r) => r.interest_level ?? "" },
                { header: "AI band", value: (r) => pretty(r.current_status) },
                { header: "Current owner", value: (r) => r.owner_name ?? "" },
                { header: "Source", value: (r) => pretty(r.source) },
                { header: "Lost reason", value: (r) => pretty(r.lost_reason) },
                { header: "Created", value: (r) => csvDateTime(r.created_at) },
                { header: "Assigned", value: (r) => csvDateTime(r.assigned_at) },
                { header: "Last worked", value: (r) => csvDateTime(r.last_worked_at) },
                { header: "Last touch", value: (r) => csvDateTime(r.last_touchpoint_at) },
                { header: "Next follow-up", value: (r) => csvDateTime(r.next_follow_up_at) },
            ],
        });
    }

    const personId = z.string().min(1).max(100).safeParse(url.searchParams.get("person_id"));
    if (!personId.success) return errorResponse("Invalid person or metric.", 400);
    const leads = await funnelByOwnerLeads(personId.data, metric.data, filters);
    return successResponse({ leads });
});
