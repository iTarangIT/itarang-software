// Module 3 — the 6 pre-canned reports (BRD §0.11). Each builder returns a
// ReportResult (columns + rows); the API route serialises it to JSON or CSV.
// Date bases and groupings follow the BRD's precise formulas verbatim.

import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { LOST_REASON } from "@/lib/lifecycle/transitions";
import { ONBOARDING_DROPOUT_REASONS } from "./types";
import type {
    DashboardFilters,
    ReportResult,
    ReportRow,
    ReportType,
} from "./types";

// Date-range fragment on a chosen column. Defaults to the last 30 days when no
// range is supplied. date_to is treated as an inclusive calendar day.
function dateRange(col: string, f: DashboardFilters): SQL {
    const c = sql.raw(col);
    if (f.date_from && f.date_to) {
        return sql` AND ${c} >= ${f.date_from}::date AND ${c} < (${f.date_to}::date + INTERVAL '1 day')`;
    }
    if (f.date_from) return sql` AND ${c} >= ${f.date_from}::date`;
    if (f.date_to) return sql` AND ${c} < (${f.date_to}::date + INTERVAL '1 day')`;
    return sql` AND ${c} >= NOW() - INTERVAL '30 days'`;
}

const num = (v: unknown): number => Number(v ?? 0);
const ratio = (a: number, b: number): number | null =>
    b > 0 ? Math.round((a / b) * 1000) / 1000 : null;

// Report 1 — Daily Activity. lead_touchpoints.performed_at, grouped by rep/day.
async function dailyActivity(f: DashboardFilters): Promise<ReportResult> {
    const rows = await db.execute<{
        day: string;
        rep_name: string | null;
        total_touchpoints: string;
        connected_calls: string;
        status_changes: string;
        leads_worked: string;
    }>(sql`
        SELECT
            t.performed_at::date AS day,
            u.name AS rep_name,
            COUNT(*)::text AS total_touchpoints,
            COUNT(*) FILTER (WHERE t.call_status = 'connected')::text AS connected_calls,
            COUNT(*) FILTER (WHERE t.touchpoint_type = 'status_change_note')::text AS status_changes,
            COUNT(DISTINCT t.dealer_lead_id)::text AS leads_worked
        FROM lead_touchpoints t
        LEFT JOIN users u ON u.id::text = t.performed_by
        WHERE t.performed_by IS NOT NULL ${dateRange("t.performed_at", f)}
        GROUP BY t.performed_at::date, u.name
        ORDER BY day DESC, rep_name ASC
    `);
    return {
        type: "daily_activity",
        columns: [
            { key: "day", label: "Date" },
            { key: "rep_name", label: "Rep" },
            { key: "total_touchpoints", label: "Touchpoints", numeric: true },
            { key: "connected_calls", label: "Connected Calls", numeric: true },
            { key: "status_changes", label: "Status Changes", numeric: true },
            { key: "leads_worked", label: "Leads Worked", numeric: true },
        ],
        rows: rows.map((r) => ({
            day: r.day,
            rep_name: r.rep_name ?? "(unknown)",
            total_touchpoints: num(r.total_touchpoints),
            connected_calls: num(r.connected_calls),
            status_changes: num(r.status_changes),
            leads_worked: num(r.leads_worked),
        })),
    };
}

// Report 2 — Lead Funnel. dealer_leads.created_at; current count per status.
async function leadFunnel(f: DashboardFilters): Promise<ReportResult> {
    const rows = await db.execute<{ lead_status: string | null; c: string }>(sql`
        SELECT dl.lead_status, COUNT(*)::text AS c
        FROM dealer_leads dl
        WHERE dl.is_active IS NOT FALSE ${dateRange("dl.created_at", f)}
        GROUP BY dl.lead_status
    `);
    const neverAssigned = await db.execute<{ c: string }>(sql`
        SELECT COUNT(*)::text AS c FROM dealer_leads dl
        WHERE dl.is_active IS NOT FALSE AND dl.lead_status = 'New_Unassigned'
          AND dl.assigned_at IS NULL ${dateRange("dl.created_at", f)}
    `);
    const byStatus = new Map(rows.map((r) => [r.lead_status ?? "(null)", num(r.c)]));
    const STATUS_ORDER = [
        "New_Unassigned",
        "Assigned_Not_Contacted",
        "Under_Discussion",
        "Commercials_Explained",
        "Commercials_Finalised",
        "Awaiting_Customer_Decision",
        "Transferred_to_ASM",
        "Converted",
        "Lost",
    ];
    const out: ReportRow[] = STATUS_ORDER.map((s) => ({
        stage: s,
        count: byStatus.get(s) ?? 0,
    }));
    out.push({ stage: "Never Assigned", count: num(neverAssigned[0]?.c) });
    return {
        type: "lead_funnel",
        columns: [
            { key: "stage", label: "Stage" },
            { key: "count", label: "Leads", numeric: true },
        ],
        rows: out,
    };
}

// Report 3 — Lost Analysis. dealer_leads.closed_at; lost_reason +
// onboarding_dropout_reason breakdowns.
async function lostAnalysis(f: DashboardFilters): Promise<ReportResult> {
    const lostRows = await db.execute<{ lost_reason: string | null; c: string }>(sql`
        SELECT dl.lost_reason, COUNT(*)::text AS c
        FROM dealer_leads dl
        WHERE dl.lead_status = 'Lost' ${dateRange("dl.closed_at", f)}
        GROUP BY dl.lost_reason
    `);
    const dropoutRows = await db.execute<{
        onboarding_dropout_reason: string | null;
        c: string;
    }>(sql`
        SELECT dl.onboarding_dropout_reason, COUNT(*)::text AS c
        FROM dealer_leads dl
        WHERE dl.onboarding_dropout_reason IS NOT NULL ${dateRange("dl.closed_at", f)}
        GROUP BY dl.onboarding_dropout_reason
    `);
    const lostMap = new Map(
        lostRows.map((r) => [r.lost_reason ?? "(unspecified)", num(r.c)]),
    );
    const dropoutMap = new Map(
        dropoutRows.map((r) => [
            r.onboarding_dropout_reason ?? "(unspecified)",
            num(r.c),
        ]),
    );
    const out: ReportRow[] = [];
    for (const reason of LOST_REASON) {
        out.push({ category: "Sales lost", reason, count: lostMap.get(reason) ?? 0 });
    }
    for (const reason of ONBOARDING_DROPOUT_REASONS) {
        out.push({
            category: "Onboarding dropout",
            reason,
            count: dropoutMap.get(reason) ?? 0,
        });
    }
    return {
        type: "lost_analysis",
        columns: [
            { key: "category", label: "Category" },
            { key: "reason", label: "Reason" },
            { key: "count", label: "Count", numeric: true },
        ],
        rows: out,
    };
}

// Report 4 — AI Score Accuracy. final_intent_score distribution, Converted vs
// Lost, for terminal leads in the window.
async function aiScoreAccuracy(f: DashboardFilters): Promise<ReportResult> {
    const rows = await db.execute<{
        bucket: string;
        converted: string;
        lost: string;
    }>(sql`
        SELECT bucket,
               COUNT(*) FILTER (WHERE lead_status = 'Converted')::text AS converted,
               COUNT(*) FILTER (WHERE lead_status = 'Lost')::text AS lost
        FROM (
            SELECT dl.lead_status,
                CASE
                    WHEN COALESCE(dl.final_intent_score, 0) <= 20 THEN '0-20'
                    WHEN dl.final_intent_score <= 40 THEN '21-40'
                    WHEN dl.final_intent_score <= 60 THEN '41-60'
                    WHEN dl.final_intent_score <= 80 THEN '61-80'
                    ELSE '81-100'
                END AS bucket
            FROM dealer_leads dl
            WHERE dl.lead_status IN ('Converted', 'Lost') ${dateRange("dl.closed_at", f)}
        ) s
        GROUP BY bucket
        ORDER BY bucket ASC
    `);
    const order = ["0-20", "21-40", "41-60", "61-80", "81-100"];
    const map = new Map(rows.map((r) => [r.bucket, r]));
    return {
        type: "ai_score_accuracy",
        columns: [
            { key: "bucket", label: "AI Score Range" },
            { key: "converted", label: "Converted", numeric: true },
            { key: "lost", label: "Lost", numeric: true },
            { key: "conversion_rate", label: "Conversion %", numeric: true },
        ],
        rows: order.map((b) => {
            const r = map.get(b);
            const conv = num(r?.converted);
            const lost = num(r?.lost);
            const rate = ratio(conv, conv + lost);
            return {
                bucket: b,
                converted: conv,
                lost,
                conversion_rate: rate != null ? Math.round(rate * 100) : null,
            };
        }),
    };
}

// Report 5 — Source Performance. closed_at; conversion rate per source.
async function sourcePerformance(f: DashboardFilters): Promise<ReportResult> {
    const rows = await db.execute<{
        source: string | null;
        converted: string;
        closed: string;
    }>(sql`
        SELECT COALESCE(dl.source, '(unknown)') AS source,
               COUNT(*) FILTER (WHERE dl.lead_status = 'Converted')::text AS converted,
               COUNT(*) FILTER (WHERE dl.lead_status IN ('Converted','Lost'))::text AS closed
        FROM dealer_leads dl
        WHERE dl.lead_status IN ('Converted', 'Lost') ${dateRange("dl.closed_at", f)}
        GROUP BY COALESCE(dl.source, '(unknown)')
        ORDER BY closed DESC
    `);
    return {
        type: "source_performance",
        columns: [
            { key: "source", label: "Source" },
            { key: "converted", label: "Converted", numeric: true },
            { key: "closed", label: "Total Closed", numeric: true },
            { key: "conversion_rate", label: "Conversion %", numeric: true },
        ],
        rows: rows.map((r) => {
            const conv = num(r.converted);
            const closed = num(r.closed);
            const rate = ratio(conv, closed);
            return {
                source: r.source ?? "(unknown)",
                converted: conv,
                closed,
                conversion_rate: rate != null ? Math.round(rate * 100) : null,
            };
        }),
    };
}

// Report 6 — ASM Handoff. asm_transfer touchpoints, grouped by recipient ASM.
async function asmHandoff(f: DashboardFilters): Promise<ReportResult> {
    const rows = await db.execute<{
        asm_name: string | null;
        handoffs: string;
        converted: string;
        closed: string;
        avg_days_to_close: string | null;
        escalations: string;
    }>(sql`
        SELECT
            u.name AS asm_name,
            COUNT(*)::text AS handoffs,
            COUNT(*) FILTER (WHERE dl.lead_status = 'Converted')::text AS converted,
            COUNT(*) FILTER (WHERE dl.lead_status IN ('Converted','Lost'))::text AS closed,
            ROUND(AVG(EXTRACT(EPOCH FROM (dl.closed_at - t.performed_at)) / 86400)
                  FILTER (WHERE dl.closed_at IS NOT NULL)::numeric, 1)::text AS avg_days_to_close,
            SUM((SELECT COUNT(*) FROM lead_escalations e
                 WHERE e.dealer_lead_id = dl.id))::text AS escalations
        FROM lead_touchpoints t
        JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
        LEFT JOIN users u ON u.id::text = dl.asm_id
        WHERE t.touchpoint_type = 'asm_transfer' ${dateRange("t.performed_at", f)}
        GROUP BY u.name
        ORDER BY handoffs DESC
    `);
    return {
        type: "asm_handoff",
        columns: [
            { key: "asm_name", label: "ASM" },
            { key: "handoffs", label: "Handoffs Received", numeric: true },
            { key: "converted", label: "Converted", numeric: true },
            { key: "conversion_rate", label: "Conversion %", numeric: true },
            { key: "avg_days_to_close", label: "Avg Days to Close", numeric: true },
            { key: "escalations", label: "Escalations", numeric: true },
        ],
        rows: rows.map((r) => {
            const conv = num(r.converted);
            const closed = num(r.closed);
            const rate = ratio(conv, closed);
            return {
                asm_name: r.asm_name ?? "(unassigned)",
                handoffs: num(r.handoffs),
                converted: conv,
                conversion_rate: rate != null ? Math.round(rate * 100) : null,
                avg_days_to_close:
                    r.avg_days_to_close != null ? Number(r.avg_days_to_close) : null,
                escalations: num(r.escalations),
            };
        }),
    };
}

export async function runReport(
    type: ReportType,
    f: DashboardFilters,
): Promise<ReportResult> {
    switch (type) {
        case "daily_activity":
            return dailyActivity(f);
        case "lead_funnel":
            return leadFunnel(f);
        case "lost_analysis":
            return lostAnalysis(f);
        case "ai_score_accuracy":
            return aiScoreAccuracy(f);
        case "source_performance":
            return sourcePerformance(f);
        case "asm_handoff":
            return asmHandoff(f);
    }
}

// Serialise a report to CSV — RFC-4180 quoting.
export function toCsv(result: ReportResult): string {
    const esc = (v: unknown): string => {
        const s = v == null ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = result.columns.map((c) => esc(c.label)).join(",");
    const lines = result.rows.map((row) =>
        result.columns.map((c) => esc(row[c.key])).join(","),
    );
    return [header, ...lines].join("\r\n");
}
