// GET /api/inside-sales/queue/export?tab=...&q=...&neodove=1&callback=1&<filters>
// The Inside Sales queue, as a CSV, for the CURRENT TAB AND FILTERS.
//
// TAKES THE SAME PARAMS AS THE LIST and runs the SAME builder, so the sheet and
// the screen can never disagree about which leads matched. That is why it is a
// server route rather than a Blob built from the rows already in the browser:
// the queue paginates at 25, and exporting what is on screen would hand over
// page 1 of 40 with no hint that it had.
//
// WHY THE COLUMNS ARE FOLLOW-UP-CENTRIC. This is a worksheet a rep works down:
// who the dealer is, how to reach them, what stage the lead is at, how warm it
// is, when it was last touched and when it is due next.

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { withErrorHandler } from "@/lib/api-utils";
import { fetchQueueRows, countQueueRows } from "@/lib/inside-sales/queryBuilder";
import { fetchAssignedByForLeads } from "@/lib/leads/leadAssignedBy";
import { QUEUE_TABS, TAB_LABELS, type QueueRow } from "@/lib/inside-sales/types";
import { LEAD_STATUS_LABEL, readQueueFilters } from "@/lib/leads/queueFilters";
import { readQueueSort } from "@/lib/leads/queueSort";
import {
    csvDateTime,
    csvPretty,
    csvResponse,
    QUEUE_EXPORT_ROW_CAP,
    type CsvColumn,
} from "@/lib/leads/queueCsv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
    q: z.string().trim().min(1).max(120).optional(),
    neodove: z.literal("1").optional(),
    callback: z.literal("1").optional(),
});

const COLUMNS: CsvColumn<QueueRow>[] = [
    { header: "Dealer", value: (r) => r.dealer_name ?? "" },
    { header: "Shop", value: (r) => r.shop_name ?? "" },
    { header: "Mobile Number", value: (r) => r.phone ?? "" },
    { header: "City", value: (r) => r.city ?? "" },
    { header: "State", value: (r) => r.state ?? "" },
    {
        header: "Status",
        // Through the same label map the row's chip uses, so a sheet and the
        // screen it came from name a stage identically.
        value: (r) => (r.lead_status ? LEAD_STATUS_LABEL[r.lead_status] : ""),
    },
    { header: "Interest", value: (r) => csvPretty(r.interest_level) },
    { header: "Intent Score", value: (r) => r.final_intent_score?.toString() ?? "" },
    { header: "Owner", value: (r) => r.current_owner_name ?? "" },
    { header: "Sent By", value: (r) => r.assigned_by?.name ?? "" },
    { header: "Language", value: (r) => r.language ?? "" },
    { header: "Attempts", value: (r) => r.total_attempts?.toString() ?? "" },
    { header: "NeoDove", value: (r) => csvPretty(r.neodove_sync_status) },
    { header: "Last Touchpoint", value: (r) => csvDateTime(r.last_touchpoint_at) },
    { header: "Next Follow-up", value: (r) => csvDateTime(r.next_follow_up_at) },
    { header: "Assigned At", value: (r) => csvDateTime(r.assigned_at) },
    { header: "Created At", value: (r) => csvDateTime(r.created_at) },
];

export const GET = withErrorHandler(async (req: NextRequest) => {
    const user = await requireRole(READ_ROLES);
    const url = new URL(req.url);
    const parsed = QuerySchema.parse({
        tab: url.searchParams.get("tab") ?? undefined,
        q: url.searchParams.get("q") ?? undefined,
        neodove: url.searchParams.get("neodove") ?? undefined,
        callback: url.searchParams.get("callback") ?? undefined,
    });
    const common = {
        tab: parsed.tab,
        userId: user.id,
        q: parsed.q ?? null,
        neodoveOnly: parsed.neodove === "1",
        callbackOnly: parsed.callback === "1",
        filters: readQueueFilters(url.searchParams),
    };

    const [rows, total] = await Promise.all([
        // The sheet is ordered the way the screen is — same params, same builder.
        fetchQueueRows({
            ...common,
            sort: readQueueSort(url.searchParams),
            page: 1,
            limit: QUEUE_EXPORT_ROW_CAP,
        }),
        countQueueRows(common),
    ]);

    // Who handed each lead over. Decorated in a SEPARATE, fail-tolerant
    // statement exactly as the list route does it, so a failure here drops one
    // column rather than the whole export.
    const assignedBy = await fetchAssignedByForLeads(
        rows.map((r) => r.id).filter(Boolean),
    );

    return csvResponse({
        rows: rows.map((r) => ({ ...r, assigned_by: assignedBy[r.id] ?? null })),
        columns: COLUMNS,
        filename: `inside-sales-${TAB_LABELS[parsed.tab].toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        total,
    });
});
