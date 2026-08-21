// GET /api/asm/queue/export?tab=...&q=...&<filters> — the ASM queue, as a CSV.
//
// TAKES THE SAME PARAMS AS THE LIST and runs the SAME builder, so the sheet and
// the screen can never disagree about which leads matched. That is the whole
// reason this is a server route rather than a Blob built from the rows already
// in the browser: the queue paginates at 25, and exporting what happens to be on
// screen would hand over page 1 of 40 with no hint that it had.
//
// WHY THE COLUMNS ARE VISIT-CENTRIC. This is a day-plan worksheet, not a data
// dump: who the dealer is, where they are, what state the lead is in, when the
// visit is, and how the last one went.

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { withErrorHandler } from "@/lib/api-utils";
import { fetchAsmQueueRows, countAsmQueueRows } from "@/lib/asm/queryBuilder";
import { readAsmQueueFilters } from "@/lib/asm/queueFilterParams";
import { fetchAssignedByForLeads } from "@/lib/leads/leadAssignedBy";
import {
    ASM_QUEUE_TABS,
    ASM_TAB_LABELS,
    VISIT_OUTCOME_LABELS,
    type AsmQueueRow,
    type VisitOutcome,
} from "@/lib/asm/types";
import { LEAD_STATUS_LABEL } from "@/lib/leads/queueFilters";
import {
    csvDate,
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
    "asm",
    "admin",
    "ceo",
    "sales_manager",
    "sales_head",
    "business_head",
];

const QuerySchema = z.object({
    tab: z.enum(ASM_QUEUE_TABS).default("my_visits"),
    q: z.string().trim().min(1).max(120).optional(),
});

const COLUMNS: CsvColumn<AsmQueueRow>[] = [
    { header: "Dealer", value: (r) => r.dealer_name ?? "" },
    { header: "Shop", value: (r) => r.shop_name ?? "" },
    { header: "Mobile Number", value: (r) => r.phone ?? "" },
    { header: "City", value: (r) => r.city ?? "" },
    { header: "State", value: (r) => r.state ?? "" },
    {
        header: "Lead Status",
        // Through the same label map the row's chip uses, so a sheet and the
        // screen it came from name a stage identically.
        value: (r) => (r.lead_status ? LEAD_STATUS_LABEL[r.lead_status] : ""),
    },
    { header: "Interest", value: (r) => csvPretty(r.interest_level) },
    { header: "Intent Score", value: (r) => r.final_intent_score?.toString() ?? "" },
    { header: "Visit Status", value: (r) => csvPretty(r.visit_status) },
    {
        header: "Visit Outcome",
        value: (r) =>
            r.visit_outcome
                ? (VISIT_OUTCOME_LABELS[r.visit_outcome as VisitOutcome] ??
                  csvPretty(r.visit_outcome))
                : "",
    },
    // Bare dates: these are DATE columns, and running them through the datetime
    // formatter would parse them as UTC midnight and print the previous day in
    // IST — a visit scheduled for the 7th appearing as the 6th.
    { header: "Scheduled Date", value: (r) => csvDate(r.scheduled_date) },
    { header: "Actual Visit Date", value: (r) => csvDate(r.actual_visit_date) },
    { header: "Owner", value: (r) => r.current_owner_name ?? "" },
    { header: "ASM", value: (r) => r.asm_name ?? "" },
    { header: "Sent By", value: (r) => r.assigned_by?.name ?? "" },
    { header: "Assigned At", value: (r) => csvDateTime(r.assigned_at) },
    { header: "Last Touchpoint", value: (r) => csvDateTime(r.last_touchpoint_at) },
    { header: "Closed At", value: (r) => csvDateTime(r.closed_at) },
];

export const GET = withErrorHandler(async (req: NextRequest) => {
    const user = await requireRole(READ_ROLES);
    const url = new URL(req.url);
    const parsed = QuerySchema.parse({
        tab: url.searchParams.get("tab") ?? undefined,
        q: url.searchParams.get("q") ?? undefined,
    });
    const filters = readAsmQueueFilters(url.searchParams);

    const [rows, total] = await Promise.all([
        fetchAsmQueueRows({
            tab: parsed.tab,
            asmId: user.id,
            page: 1,
            limit: QUEUE_EXPORT_ROW_CAP,
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

    // Who handed each lead over. Decorated in a SEPARATE, fail-tolerant
    // statement exactly as the list route does it — the builder does not select
    // it, and a column that always printed blank would read as data loss rather
    // than as a stamp this sheet chose not to carry.
    const assignedBy = await fetchAssignedByForLeads(
        rows.map((r) => r.id).filter(Boolean),
    );

    return csvResponse({
        rows: rows.map((r) => ({ ...r, assigned_by: assignedBy[r.id] ?? null })),
        columns: COLUMNS,
        filename: `asm-${ASM_TAB_LABELS[parsed.tab].toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        total,
    });
});
