/**
 * GET /api/scraper/runs/[id]/export.xlsx
 *
 * Single .xlsx with two sheets per the user's spec:
 *
 *   "Total" — every raw upstream lead the scraper found (one row per
 *             `scraper_raw` record for this run, including ones that were
 *             later de-duped). `was_saved` flags which raw rows actually
 *             made it into `scraped_dealer_leads`.
 *
 *   "Saved" — the de-duped, cleaned leads (one row per
 *             `scraped_dealer_leads` record for this run). Includes the
 *             full upstream address via COALESCE from raw_data or the
 *             matching `scraper_raw` row.
 *
 * The Total sheet matches the `scraper_runs.total_found` stat and the
 * Saved sheet matches the `scraper_runs.new_leads_saved` stat in the
 * detail page header.
 */

import { db } from "@/lib/db";
import { scrapedDealerLeads, scraperRaw, users } from "@/lib/db/schema";
import { withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { eq, desc, sql } from "drizzle-orm";
import ExcelJS from "exceljs";

interface RawLeadShape {
    name?: string | null;
    phone?: string | null;
    address?: string | null;
    email?: string | null;
    website?: string | null;
    source?: string | null;
    city?: string | null;
    state?: string | null;
}

function safeParse(json: string | null): RawLeadShape {
    if (!json) return {};
    try {
        const parsed = JSON.parse(json);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function styleHeader(row: ExcelJS.Row) {
    row.eachCell((cell) => {
        cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF1A1A1A" },
        };
        cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
        cell.alignment = { vertical: "middle", horizontal: "center" };
    });
    row.height = 28;
}

function fmt(d: Date | null | undefined): string {
    return d
        ? new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
        : "—";
}

export const GET = withErrorHandler(
    async (
        _req: Request,
        { params }: { params: Promise<{ id: string }> },
    ) => {
        await requireRole(["sales_head", "ceo", "business_head"]);
        const { id } = await params;

        // ── Pull raw + saved in parallel ──────────────────────
        // Same name-based fallback as /api/scraper/leads — see that route
        // for the rationale. Going forward, saveCleanLeads populates
        // raw_data.address so the subquery is skipped.
        const fullAddressSql = sql<string | null>`COALESCE(
            NULLIF(${scrapedDealerLeads.raw_data}->>'address', ''),
            (
                SELECT (r.raw_data::jsonb)->>'address'
                FROM scraper_raw r
                WHERE r.run_id = ${scrapedDealerLeads.scraper_run_id}
                  AND LOWER(TRIM((r.raw_data::jsonb)->>'name')) =
                      LOWER(TRIM(${scrapedDealerLeads.dealer_name}))
                  AND (r.raw_data::jsonb)->>'address' IS NOT NULL
                  AND (r.raw_data::jsonb)->>'address' <> ''
                LIMIT 1
            )
        )`.as("full_address");

        const [rawRows, savedRows] = await Promise.all([
            db
                .select({
                    id: scraperRaw.id,
                    raw_data: scraperRaw.raw_data,
                    created_at: scraperRaw.created_at,
                })
                .from(scraperRaw)
                .where(eq(scraperRaw.run_id, id))
                .orderBy(desc(scraperRaw.created_at)),
            db
                .select({
                    id: scrapedDealerLeads.id,
                    dealer_name: scrapedDealerLeads.dealer_name,
                    phone: scrapedDealerLeads.phone,
                    full_address: fullAddressSql,
                    location_city: scrapedDealerLeads.location_city,
                    location_state: scrapedDealerLeads.location_state,
                    source_url: scrapedDealerLeads.source_url,
                    email: scrapedDealerLeads.email,
                    website: scrapedDealerLeads.website,
                    gst_number: scrapedDealerLeads.gst_number,
                    business_type: scrapedDealerLeads.business_type,
                    quality_score: scrapedDealerLeads.quality_score,
                    exploration_status: scrapedDealerLeads.exploration_status,
                    assigned_to_name: users.name,
                    created_at: scrapedDealerLeads.created_at,
                })
                .from(scrapedDealerLeads)
                .leftJoin(users, eq(scrapedDealerLeads.assigned_to, users.id))
                .where(eq(scrapedDealerLeads.scraper_run_id, id))
                .orderBy(desc(scrapedDealerLeads.created_at)),
        ]);

        // Set of phones that landed in scraped_dealer_leads — used to flag
        // `was_saved` on each Total-sheet row.
        const savedPhones = new Set<string>(
            savedRows.map((r) => (r.phone ?? "").trim()).filter(Boolean),
        );

        // ── Workbook ──────────────────────────────────────────
        const workbook = new ExcelJS.Workbook();
        workbook.creator = "iTarang";
        workbook.created = new Date();

        // ── "Total" sheet — every raw upstream lead ───────────
        const totalSheet = workbook.addWorksheet("Total", {
            views: [{ state: "frozen", ySplit: 1 }],
        });
        totalSheet.columns = [
            { header: "Dealer Name", key: "dealer_name", width: 32 },
            { header: "Phone", key: "phone", width: 18 },
            { header: "Address", key: "address", width: 60 },
            { header: "City", key: "city", width: 18 },
            { header: "State", key: "state", width: 18 },
            { header: "Email", key: "email", width: 28 },
            { header: "Website", key: "website", width: 32 },
            { header: "Source URL", key: "source_url", width: 36 },
            { header: "Saved?", key: "was_saved", width: 10 },
            { header: "Scraped At", key: "scraped_at", width: 22 },
        ];
        styleHeader(totalSheet.getRow(1));

        rawRows.forEach((r, i) => {
            const parsed = safeParse(r.raw_data);
            const phone = (parsed.phone ?? "").trim();
            const row = totalSheet.addRow({
                dealer_name: parsed.name ?? "—",
                phone: phone || "—",
                address: parsed.address ?? "—",
                city: parsed.city ?? "—",
                state: parsed.state ?? "—",
                email: parsed.email ?? "—",
                website: parsed.website ?? "—",
                source_url: parsed.source ?? "—",
                was_saved: phone && savedPhones.has(phone) ? "TRUE" : "FALSE",
                scraped_at: fmt(r.created_at),
            });
            if (i % 2 === 0) {
                row.eachCell((cell) => {
                    cell.fill = {
                        type: "pattern",
                        pattern: "solid",
                        fgColor: { argb: "FFF9FAFB" },
                    };
                });
            }
            row.eachCell((cell) => {
                cell.alignment = { vertical: "middle", wrapText: true };
                cell.border = {
                    bottom: { style: "hair", color: { argb: "FFE5E7EB" } },
                };
            });
        });

        if (rawRows.length > 0) {
            totalSheet.autoFilter = {
                from: { row: 1, column: 1 },
                to: { row: 1, column: totalSheet.columns.length },
            };
        }

        // ── "Saved" sheet — only the rows that landed in dealer_leads-style staging ──
        const savedSheet = workbook.addWorksheet("Saved", {
            views: [{ state: "frozen", ySplit: 1 }],
        });
        savedSheet.columns = [
            { header: "Dealer Name", key: "dealer_name", width: 32 },
            { header: "Phone", key: "phone", width: 18 },
            { header: "Full Address", key: "full_address", width: 60 },
            { header: "City", key: "city", width: 18 },
            { header: "State", key: "state", width: 18 },
            { header: "Email", key: "email", width: 28 },
            { header: "Website", key: "website", width: 32 },
            { header: "GST Number", key: "gst_number", width: 22 },
            { header: "Business Type", key: "business_type", width: 20 },
            { header: "Quality Score", key: "quality_score", width: 14 },
            { header: "Source URL", key: "source_url", width: 36 },
            {
                header: "Exploration Status",
                key: "exploration_status",
                width: 18,
            },
            { header: "Assigned To", key: "assigned_to_name", width: 22 },
            { header: "Scraped At", key: "scraped_at", width: 22 },
        ];
        styleHeader(savedSheet.getRow(1));

        savedRows.forEach((r, i) => {
            const row = savedSheet.addRow({
                dealer_name: r.dealer_name ?? "—",
                phone: r.phone ?? "—",
                full_address:
                    r.full_address ??
                    [r.location_city, r.location_state]
                        .filter(Boolean)
                        .join(", ") ??
                    "—",
                city: r.location_city ?? "—",
                state: r.location_state ?? "—",
                email: r.email ?? "—",
                website: r.website ?? "—",
                gst_number: r.gst_number ?? "—",
                business_type: r.business_type ?? "—",
                quality_score: r.quality_score ?? "—",
                source_url: r.source_url ?? "—",
                exploration_status: r.exploration_status ?? "—",
                assigned_to_name: r.assigned_to_name ?? "Unassigned",
                scraped_at: fmt(r.created_at),
            });
            if (i % 2 === 0) {
                row.eachCell((cell) => {
                    cell.fill = {
                        type: "pattern",
                        pattern: "solid",
                        fgColor: { argb: "FFF9FAFB" },
                    };
                });
            }
            row.eachCell((cell) => {
                cell.alignment = { vertical: "middle", wrapText: true };
                cell.border = {
                    bottom: { style: "hair", color: { argb: "FFE5E7EB" } },
                };
            });
        });

        if (savedRows.length > 0) {
            savedSheet.autoFilter = {
                from: { row: 1, column: 1 },
                to: { row: 1, column: savedSheet.columns.length },
            };
        }

        // ── Stream out ────────────────────────────────────────
        const buffer = await workbook.xlsx.writeBuffer();
        const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
        const filename = `scraper_run_${safeId}.xlsx`;

        return new Response(Buffer.from(buffer), {
            status: 200,
            headers: {
                "Content-Type":
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "Content-Disposition": `attachment; filename="${filename}"`,
                "Content-Length": buffer.byteLength.toString(),
                "Cache-Control": "no-store",
            },
        });
    },
);
