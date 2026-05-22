/**
 * GET /api/scraper/runs/[id]/raw-leads
 *
 * Returns every raw upstream lead the scraper found for this run — one row
 * per `scraper_raw` record, including rows that got de-duped before
 * landing in `scraped_dealer_leads`. Powers the "Total" tab on the run
 * detail page (matches `scraper_runs.total_found`).
 *
 * Each `scraper_raw.raw_data` is a JSON-stringified upstream object
 * (`{ name, phone, address, email, website, source, ... }`) per
 * `src/lib/scraper/storage/rawStore.ts:12`. We parse server-side so the
 * client gets a flat row shape.
 *
 * Query params:
 *   search – ILIKE on dealer name / phone / address (after JSON parse)
 *   page   – 1-indexed (default 1)
 *   limit  – default 50, max 200
 *
 * Response:
 *   { success: true, data: RawLead[], meta: { total, limit, page } }
 *
 * `total` reflects every raw row before filtering — we filter in JS after
 * the parse, so the total is the unfiltered count for context.
 */

import { db } from "@/lib/db";
import { scraperRaw, scrapedDealerLeads } from "@/lib/db/schema";
import { withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { eq, desc } from "drizzle-orm";
import { NextResponse } from "next/server";

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

interface RawLeadRow {
    id: string;
    dealer_name: string;
    phone: string | null;
    address: string | null;
    email: string | null;
    website: string | null;
    source: string | null;
    was_saved: boolean;
    created_at: string | null;
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

export const GET = withErrorHandler(
    async (
        req: Request,
        { params }: { params: Promise<{ id: string }> },
    ) => {
        await requireRole(["sales_head", "ceo", "business_head"]);
        const { id } = await params;

        const { searchParams } = new URL(req.url);
        const search = searchParams.get("search")?.trim().toLowerCase() ?? "";
        const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
        const limit = Math.min(
            200,
            Math.max(1, parseInt(searchParams.get("limit") ?? "50")),
        );

        // Load raw rows + saved phone+name keys in parallel. We compute the
        // was_saved flag in JS because the canonical join key for the
        // address fallback (dealer_name) is also what tells us if a raw
        // record made it through.
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
                    dealer_name: scrapedDealerLeads.dealer_name,
                    phone: scrapedDealerLeads.phone,
                })
                .from(scrapedDealerLeads)
                .where(eq(scrapedDealerLeads.scraper_run_id, id)),
        ]);

        // Build a set of normalized name + phone keys that survived dedup.
        const savedKeys = new Set<string>();
        for (const r of savedRows) {
            if (r.dealer_name) {
                savedKeys.add(`n:${(r.dealer_name ?? "").trim().toLowerCase()}`);
            }
            if (r.phone) {
                savedKeys.add(`p:${r.phone.replace(/\D/g, "")}`);
            }
        }

        const parsed: RawLeadRow[] = rawRows.map((r) => {
            const item = safeParse(r.raw_data);
            const name = (item.name ?? "").trim();
            const phoneNormalized = (item.phone ?? "").replace(/\D/g, "");
            const was_saved =
                (!!name && savedKeys.has(`n:${name.toLowerCase()}`)) ||
                (!!phoneNormalized && savedKeys.has(`p:${phoneNormalized}`));
            return {
                id: r.id,
                dealer_name: name || "—",
                phone: item.phone ?? null,
                address: item.address ?? null,
                email: item.email ?? null,
                website: item.website ?? null,
                source: item.source ?? null,
                was_saved,
                created_at: r.created_at
                    ? new Date(r.created_at).toISOString()
                    : null,
            };
        });

        const filtered = search
            ? parsed.filter((row) => {
                  const hay = [
                      row.dealer_name,
                      row.phone,
                      row.address,
                  ]
                      .filter(Boolean)
                      .join(" ")
                      .toLowerCase();
                  return hay.includes(search);
              })
            : parsed;

        const total = filtered.length;
        const offset = (page - 1) * limit;
        const pageRows = filtered.slice(offset, offset + limit);

        return NextResponse.json({
            success: true,
            data: pageRows,
            meta: { total, limit, page },
            timestamp: new Date().toISOString(),
        });
    },
);
