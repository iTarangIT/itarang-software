// CSV export of the unified converted-leads view. Mirrors the pattern of
// `/api/scraper-leads/converted/download` (Excel sibling) but emits text/csv
// because the spec wants a plain CSV that opens cleanly anywhere.
//
// The query reuses buildConvertedQuery so the export matches exactly what
// the table shows for the same filter set — pagination is dropped on the
// way in by passing a huge limit. We cap at 50k rows to keep this a
// single in-memory response; above that, switch to a ReadableStream.

import { db } from "@/lib/db";
import { withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { buildConvertedQuery } from "@/lib/sales-insight/query";

const ALLOWED_ROLES = [
    "sales_insight",
    "sales_manager",
    "sales_head",
    "business_head",
    "ceo",
] as const;

const MAX_EXPORT_ROWS = 50_000;

// CSV cell encoder. Wraps anything that contains a quote, comma, CR, or LF
// in quotes and doubles inner quotes — the RFC 4180 rule. Numbers come in
// as-is; null/undefined become an empty cell.
function csvCell(value: unknown): string {
    if (value === null || value === undefined) return "";
    const s = typeof value === "string" ? value : String(value);
    if (/[",\r\n]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole([...ALLOWED_ROLES]);

    const { searchParams } = new URL(req.url);
    const filters = {
        from_date: searchParams.get("from_date") || null,
        to_date: searchParams.get("to_date") || null,
        region: searchParams.get("region"),
        dealer_id: searchParams.get("dealer_id"),
        search: searchParams.get("search"),
        page: 1,
        limit: MAX_EXPORT_ROWS,
    };

    const { rowsSql } = buildConvertedQuery(filters);
    const result = (await db.execute(rowsSql)) as unknown as Array<Record<string, unknown>>;

    const headers = [
        "Source",
        "Name",
        "Phone",
        "Region",
        "Dealer ID",
        "Converted At (IST)",
        "Intent Score",
        "Also In",
        "Raw Ref",
    ];

    const lines: string[] = [headers.join(",")];
    for (const r of result) {
        const convertedAt = r.converted_at
            ? new Date(r.converted_at as string).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
            : "";
        lines.push(
            [
                csvCell(r.source),
                csvCell(r.display_name),
                csvCell(r.phone),
                csvCell(r.region),
                csvCell(r.dealer_id),
                csvCell(convertedAt),
                csvCell(r.intent_score),
                csvCell(Array.isArray(r.also_in) ? (r.also_in as string[]).join("|") : ""),
                csvCell(r.raw_ref),
            ].join(","),
        );
    }

    const filename = `iTarang_Converted_Leads_${new Date().toISOString().slice(0, 10)}.csv`;
    // Prefix BOM so Excel opens UTF-8 cleanly with non-ASCII names.
    const body = "﻿" + lines.join("\r\n");

    return new Response(body, {
        status: 200,
        headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
        },
    });
});
