/**
 * GET /api/scraper/runs/[id]/leads.csv
 *
 * Per-run CSV export of every scraped_dealer_leads row tied to the given
 * scraper run. Unlike `/api/scraper/leads` this endpoint:
 *   - Is run-scoped (caller can't accidentally dump the entire table)
 *   - Streams plain text/csv with a Content-Disposition attachment header
 *   - Has no pagination — it always returns the full run
 *
 * Role-gated to the same set as the JSON list endpoint, minus sales_manager
 * (CSV is an operator export, not a per-rep view).
 */

import { db } from "@/lib/db";
import { scrapedDealerLeads, users } from "@/lib/db/schema";
import { withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { eq, desc } from "drizzle-orm";
import { NextResponse } from "next/server";

// RFC 4180-style CSV cell quoting: wrap in quotes if it contains comma,
// quote, newline, or starts/ends with whitespace; escape inner quotes by
// doubling them. Pass-through plain values for compactness.
function csvCell(value: unknown): string {
    if (value === null || value === undefined) return "";
    const s = String(value);
    if (s === "") return "";
    if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

const COLUMNS: { header: string; key: string }[] = [
    { header: "id", key: "id" },
    { header: "dealer_name", key: "dealer_name" },
    { header: "phone", key: "phone" },
    { header: "phone_valid", key: "phone_valid" },
    { header: "location_city", key: "location_city" },
    { header: "location_state", key: "location_state" },
    { header: "source_url", key: "source_url" },
    { header: "email", key: "email" },
    { header: "website", key: "website" },
    { header: "gst_number", key: "gst_number" },
    { header: "business_type", key: "business_type" },
    { header: "products_sold", key: "products_sold" },
    { header: "quality_score", key: "quality_score" },
    { header: "exploration_status", key: "exploration_status" },
    { header: "assigned_to_name", key: "assigned_to_name" },
    { header: "converted_lead_id", key: "converted_lead_id" },
    { header: "created_at", key: "created_at" },
];

export const GET = withErrorHandler(
    async (
        _req: Request,
        { params }: { params: Promise<{ id: string }> },
    ) => {
        await requireRole(["sales_head", "ceo", "business_head"]);
        const { id } = await params;

        const rows = await db
            .select({
                id: scrapedDealerLeads.id,
                dealer_name: scrapedDealerLeads.dealer_name,
                phone: scrapedDealerLeads.phone,
                phone_valid: scrapedDealerLeads.phone_valid,
                location_city: scrapedDealerLeads.location_city,
                location_state: scrapedDealerLeads.location_state,
                source_url: scrapedDealerLeads.source_url,
                email: scrapedDealerLeads.email,
                website: scrapedDealerLeads.website,
                gst_number: scrapedDealerLeads.gst_number,
                business_type: scrapedDealerLeads.business_type,
                products_sold: scrapedDealerLeads.products_sold,
                quality_score: scrapedDealerLeads.quality_score,
                exploration_status: scrapedDealerLeads.exploration_status,
                converted_lead_id: scrapedDealerLeads.converted_lead_id,
                created_at: scrapedDealerLeads.created_at,
                assigned_to_name: users.name,
            })
            .from(scrapedDealerLeads)
            .leftJoin(users, eq(scrapedDealerLeads.assigned_to, users.id))
            .where(eq(scrapedDealerLeads.scraper_run_id, id))
            .orderBy(desc(scrapedDealerLeads.created_at));

        const headerLine = COLUMNS.map((c) => csvCell(c.header)).join(",");
        const dataLines = rows.map((row: any) =>
            COLUMNS.map((c) => csvCell(row[c.key])).join(","),
        );
        // BOM so Excel auto-detects UTF-8 for Indian language names etc.
        const body = "﻿" + [headerLine, ...dataLines].join("\r\n") + "\r\n";

        const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
        return new NextResponse(body, {
            status: 200,
            headers: {
                "Content-Type": "text/csv; charset=utf-8",
                "Content-Disposition": `attachment; filename="scraper_run_${safeId}_leads.csv"`,
                "Cache-Control": "no-store",
            },
        });
    },
);
