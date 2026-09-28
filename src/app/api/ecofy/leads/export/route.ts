// GET /api/ecofy/leads/export?tab=&q=&<filters> — the Ecofy leads list as a CSV.
//
// Same params, same query builder as the list route, so the sheet and the
// screen can never disagree about which leads matched (the pattern of
// /api/asm/queue/export). Capped at QUEUE_EXPORT_ROW_CAP; the cap is reported
// in the X-Export-* headers that QueueCsvButton reads.

import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_ALL_ROLES, ECOFY_ROLE_LABEL, ECOFY_STAGE_LABELS } from "@/lib/ecofy/access";
import { readEcofyListParams, type EcofyListRow } from "@/lib/ecofy/listTypes";
import { EcofyForbiddenError, ecofyListFilterFor, listEcofyLeadsPage, toEcofyListRow } from "@/lib/ecofy/queries";
import { csvDateTime, csvPretty, csvResponse, QUEUE_EXPORT_ROW_CAP, type CsvColumn } from "@/lib/leads/queueCsv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const COLUMNS: CsvColumn<EcofyListRow>[] = [
    { header: "Case", value: (r) => r.caseNo ?? "" },
    { header: "Segment", value: (r) => r.segment ?? "" },
    { header: "Customer", value: (r) => r.customerName ?? "" },
    { header: "Mobile Number", value: (r) => r.customerMobile ?? "" },
    { header: "City", value: (r) => r.city ?? "" },
    { header: "State", value: (r) => r.state ?? "" },
    // Through the same label map the row's chip uses, so a sheet and the
    // screen it came from name a stage identically.
    { header: "Stage", value: (r) => (r.stage ? `${r.stage} · ${ECOFY_STAGE_LABELS[r.stage] ?? r.stage}` : "") },
    { header: "Sub-status", value: (r) => csvPretty(r.subStatus) },
    { header: "Temperature", value: (r) => csvPretty(r.temperature) },
    { header: "Product Interest", value: (r) => csvPretty(r.productInterest) },
    { header: "Owner", value: (r) => r.assigneeName ?? "" },
    { header: "Owner Role", value: (r) => (r.assignedRole ? ECOFY_ROLE_LABEL[r.assignedRole] ?? r.assignedRole : "") },
    { header: "Next Follow-up", value: (r) => csvDateTime(r.nextFollowUpAt) },
    { header: "Next Meeting", value: (r) => csvDateTime(r.nextAppointmentAt) },
    { header: "In Queue Since", value: (r) => csvDateTime(r.queueEnteredAt) },
];

export const GET = withErrorHandler(async (req: NextRequest) => {
    const user = await requireRole([...ECOFY_ALL_ROLES]);
    const params = readEcofyListParams(new URL(req.url).searchParams);
    let filter;
    try {
        filter = ecofyListFilterFor(user, { ...params, page: 1, limit: QUEUE_EXPORT_ROW_CAP });
    } catch (e) {
        if (e instanceof EcofyForbiddenError) return errorResponse(e.message, 403);
        throw e;
    }
    const { rows, total } = await listEcofyLeadsPage(filter);
    return csvResponse({
        rows: rows.map(toEcofyListRow),
        columns: COLUMNS,
        filename: `ecofy-${params.tab}`,
        total,
    });
});
