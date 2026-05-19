// Paginated JSON list of converted leads unified across dealer_leads
// (AI dialer, intent_score >= 75) and leads (converted_deal_id NOT NULL).
//
// KPIs come back in the same response on purpose — see the comment in
// query.ts about snapshot consistency: separating them would let the
// table and the cards reflect different filter snapshots while a request
// was in flight.

import { db } from "@/lib/db";
import { withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { NextResponse } from "next/server";
import { buildConvertedQuery } from "@/lib/sales-insight/query";
import type { ConvertedRow, Kpis, LeadSource } from "@/lib/sales-insight/types";

const ALLOWED_ROLES = [
    "sales_insight",
    "sales_manager",
    "sales_head",
    "business_head",
    "ceo",
] as const;

function parseFilters(searchParams: URLSearchParams) {
    const fromDate = searchParams.get("from_date");
    const toDate = searchParams.get("to_date");
    return {
        from_date: fromDate || null,
        to_date: toDate || null,
        region: searchParams.get("region"),
        dealer_id: searchParams.get("dealer_id"),
        search: searchParams.get("search"),
        page: Number(searchParams.get("page") || 1),
        limit: Number(searchParams.get("limit") || 25),
    };
}

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole([...ALLOWED_ROLES]);

    const { searchParams } = new URL(req.url);
    const filters = parseFilters(searchParams);
    const { rowsSql, countSql, kpiSql, totalLeadsSql } = buildConvertedQuery(filters);

    const [rowsResult, countResult, kpiResult, totalLeadsResult] = await Promise.all([
        db.execute(rowsSql),
        db.execute(countSql),
        db.execute(kpiSql),
        db.execute(totalLeadsSql),
    ]);

    const rows = (rowsResult as unknown as Array<Record<string, unknown>>).map(
        (r): ConvertedRow => ({
            id: String(r.id),
            source: String(r.source) as LeadSource,
            display_name: r.display_name == null ? "—" : String(r.display_name),
            phone: r.phone == null ? "" : String(r.phone),
            region: r.region == null ? null : String(r.region),
            dealer_id: r.dealer_id == null ? null : String(r.dealer_id),
            converted_at: r.converted_at == null ? null : new Date(r.converted_at as string).toISOString(),
            intent_score: r.intent_score == null ? null : Number(r.intent_score),
            raw_ref: String(r.raw_ref),
            also_in: Array.isArray(r.also_in) ? (r.also_in as LeadSource[]) : [],
        }),
    );

    const total = Number(
        (countResult as unknown as Array<{ count: number }>)[0]?.count ?? 0,
    );

    const kpiRow = (kpiResult as unknown as Array<Record<string, unknown>>)[0] ?? {};
    const totalLeads = Number(
        (totalLeadsResult as unknown as Array<{ count: number }>)[0]?.count ?? 0,
    );

    const totalConverted = Number(kpiRow.total_converted ?? 0);
    const kpis: Kpis = {
        total_converted: totalConverted,
        this_month_converted: Number(kpiRow.this_month_converted ?? 0),
        avg_intent_score_ai: kpiRow.avg_intent_score_ai == null
            ? null
            : Number(kpiRow.avg_intent_score_ai),
        conversion_rate_pct: totalLeads > 0
            ? Number(((totalConverted / totalLeads) * 100).toFixed(1))
            : null,
    };

    return NextResponse.json({
        success: true,
        rows,
        total,
        page: filters.page,
        limit: filters.limit,
        kpis,
    });
});
