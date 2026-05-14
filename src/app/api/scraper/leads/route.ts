/**
 * GET /api/scraper/leads
 *
 * Sales Head / CEO / Business Head: returns ALL scraped leads.
 * Sales Manager: returns only leads assigned to them.
 *
 * Query params:
 *   run_id   – filter by scraper run
 *   status   – filter by exploration_status
 *   search   – case-insensitive ILIKE on dealer_name, phone, location_city
 *   sort     – created_at_desc (default) | created_at_asc | dealer_name_asc |
 *              dealer_name_desc | status_asc
 *   limit    – default 50, max 200
 *   offset   – default 0
 *
 * Response shape:
 *   { success: true, data: LeadRow[], meta: { total, limit, offset }, timestamp }
 *
 * `meta.total` is the count BEFORE limit/offset so the client can paginate
 * and show "Showing X-Y of N". Existing callers reading `json.data` as an
 * array keep working — `meta` is additive.
 */

import { db } from "@/lib/db";
import { scrapedDealerLeads, users } from "@/lib/db/schema";
import { withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { and, eq, desc, asc, ilike, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

type SortKey =
    | "created_at_desc"
    | "created_at_asc"
    | "dealer_name_asc"
    | "dealer_name_desc"
    | "status_asc";

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole([
        "sales_head",
        "ceo",
        "business_head",
        "sales_manager",
    ]);

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const runId = searchParams.get("run_id");
    const search = searchParams.get("search")?.trim() ?? "";
    const sortRaw = (searchParams.get("sort") ?? "created_at_desc") as SortKey;
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "50"), 200);
    const offset = Math.max(0, parseInt(searchParams.get("offset") ?? "0"));

    const conditions = [];

    // Role-based scoping
    if (user.role === "sales_manager") {
        conditions.push(eq(scrapedDealerLeads.assigned_to, user.id));
    }
    if (status) {
        conditions.push(eq(scrapedDealerLeads.exploration_status, status));
    }
    if (runId) {
        conditions.push(eq(scrapedDealerLeads.scraper_run_id, runId));
    }
    if (search) {
        const pattern = `%${search}%`;
        conditions.push(
            or(
                ilike(scrapedDealerLeads.dealer_name, pattern),
                ilike(scrapedDealerLeads.phone, pattern),
                ilike(scrapedDealerLeads.location_city, pattern),
            )!,
        );
    }

    const whereClause = conditions.length ? and(...conditions) : undefined;

    const orderBy = (() => {
        switch (sortRaw) {
            case "created_at_asc":
                return asc(scrapedDealerLeads.created_at);
            case "dealer_name_asc":
                return asc(scrapedDealerLeads.dealer_name);
            case "dealer_name_desc":
                return desc(scrapedDealerLeads.dealer_name);
            case "status_asc":
                return asc(scrapedDealerLeads.exploration_status);
            case "created_at_desc":
            default:
                return desc(scrapedDealerLeads.created_at);
        }
    })();

    // Surface the full upstream address. `scraped_dealer_leads.raw_data` is
    // populated going forward by saveCleanLeads, but older rows are NULL —
    // for those, fall back to the matching `scraper_raw` row. We match on
    // LOWER(TRIM(dealer_name)) within the same run because:
    //   (a) names within a single scrape are effectively unique after
    //       dedup (we've already filtered to one row per phone)
    //   (b) phone formats can drift (Google Places uses nationalPhoneNumber
    //       with spaces/leading zero; clean storage may strip them)
    //   (c) name is the user-visible link between the two tables, so a
    //       miss is easy to diagnose in pgAdmin if needed
    // We also require the candidate address to be non-empty so the join
    // doesn't return a blank string and shadow a real value elsewhere.
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

    const [rows, countResult] = await Promise.all([
        db
            .select({
                id: scrapedDealerLeads.id,
                scraper_run_id: scrapedDealerLeads.scraper_run_id,
                dealer_name: scrapedDealerLeads.dealer_name,
                phone: scrapedDealerLeads.phone,
                full_address: fullAddressSql,
                location_city: scrapedDealerLeads.location_city,
                location_state: scrapedDealerLeads.location_state,
                source_url: scrapedDealerLeads.source_url,
                exploration_status: scrapedDealerLeads.exploration_status,
                exploration_notes: scrapedDealerLeads.exploration_notes,
                explored_at: scrapedDealerLeads.explored_at,
                assigned_to: scrapedDealerLeads.assigned_to,
                assigned_at: scrapedDealerLeads.assigned_at,
                converted_lead_id: scrapedDealerLeads.converted_lead_id,
                created_at: scrapedDealerLeads.created_at,
                updated_at: scrapedDealerLeads.updated_at,
                email: scrapedDealerLeads.email,
                gst_number: scrapedDealerLeads.gst_number,
                business_type: scrapedDealerLeads.business_type,
                products_sold: scrapedDealerLeads.products_sold,
                website: scrapedDealerLeads.website,
                quality_score: scrapedDealerLeads.quality_score,
                phone_valid: scrapedDealerLeads.phone_valid,
                assigned_to_name: users.name,
            })
            .from(scrapedDealerLeads)
            .leftJoin(users, eq(scrapedDealerLeads.assigned_to, users.id))
            .where(whereClause)
            .orderBy(orderBy)
            .limit(limit)
            .offset(offset),
        db
            .select({ count: sql<number>`count(*)::int` })
            .from(scrapedDealerLeads)
            .where(whereClause),
    ]);

    return NextResponse.json({
        success: true,
        data: rows,
        meta: {
            total: Number(countResult[0]?.count ?? 0),
            limit,
            offset,
        },
        timestamp: new Date().toISOString(),
    });
});
