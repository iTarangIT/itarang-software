// 24 Nov — CSV for the Team pages, with the lead-export conventions
// (BOM, CRLF, IST timestamps; see src/lib/leads/queueCsv.ts).

import { csvDateTime, csvEscape } from "@/lib/leads/queueCsv";
import { businessTypeLabel } from "@/lib/leads/businessType";
import { storedSegments } from "@/lib/leads/segments";

const segs = (v: unknown) => storedSegments(v).join(", ");
import type { TeamLeadRow, TeamVisitRow } from "./teamLeads";

const label = (v: string | null | undefined) => (v ? v.replace(/_/g, " ") : "");

function toCsv(header: string[], rows: unknown[][], truncated: boolean): string {
    const lines = [header, ...rows].map((r) => r.map(csvEscape).join(","));
    if (truncated) lines.push(csvEscape("… more rows than the download limit — narrow the filters."));
    return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function teamLeadsCsv(rows: TeamLeadRow[], truncated: boolean): string {
    return toCsv(
        ["Lead ID", "Dealer", "City", "Type of business", "Segment", "Status", "Temperature", "Owner",
            "Latest action", "Latest action at", "Latest action by", "Latest comment", "Comment at", "Comment by", "Next follow-up"],
        rows.map((r) => [
            r.id, r.name, r.city, businessTypeLabel(r.business_type), segs(r.segments), label(r.lead_status), r.interest_level, r.owner_name,
            label(r.last_action_type), csvDateTime(r.last_action_at), r.last_action_by, r.last_comment,
            csvDateTime(r.last_comment_at), r.last_comment_by, csvDateTime(r.next_follow_up_at),
        ]),
        truncated,
    );
}

export function teamVisitsCsv(rows: TeamVisitRow[], truncated: boolean): string {
    return toCsv(
        ["Lead ID", "Dealer", "City", "Type of business", "Segment", "Rep", "Scheduled for", "Visited on", "Visit status",
            "Outcome", "Remarks", "Next visit", "Photo + location verified"],
        rows.map((r) => [
            r.lead_id, r.lead_name, r.city, businessTypeLabel(r.business_type), segs(r.segments), r.rep_name, r.scheduled_date,
            r.actual_visit_date, label(r.visit_status), label(r.visit_outcome), r.visit_remarks, r.next_visit_date,
            r.verified ? "Yes" : "No",
        ]),
        truncated,
    );
}

export function csvResponse(body: string, filename: string): Response {
    return new Response(body, {
        headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Cache-Control": "no-store",
        },
    });
}
