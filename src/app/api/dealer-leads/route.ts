import { db } from "@/lib/db";
import { dealerLeads, scraperLeads } from "@/lib/db/schema";
import { and, desc, ilike, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import {
  normalizeCity,
  normalizeState,
  inferStateFromCity,
} from "@/lib/scraper-enrichment";
import { recordLeadCapture } from "@/lib/leads/lead-registry";
import {
  classifyAgainstExisting,
  loadExistingByPhone,
  normalizePhone,
} from "@/lib/leads/dedupe";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const {
      dealer_name,
      phone,
      shop_name,
      location,
      language,
      current_status,
      state,
      city,
      area,
      pincode,
    } = body;

    if (!dealer_name || !phone) {
      return NextResponse.json(
        { success: false, error: "dealer_name and phone are required" },
        { status: 400 },
      );
    }

    // E-224 — normalise BEFORE storing or comparing. This route used to write
    // whatever the caller typed and dedupe on the raw string, so "98765 43210"
    // and "+919876543210" were two different dealers to it: the duplicate check
    // passed, the row inserted, and that lead could never again be matched by
    // any importer (all of which normalise). Same engine as the bulk wizard,
    // the /leads Import button and NeoDove inbound.
    const normalizedPhone = normalizePhone(String(phone));
    if (!normalizedPhone) {
      return NextResponse.json(
        {
          success: false,
          error: "Enter a valid 10-digit Indian mobile number.",
        },
        { status: 400 },
      );
    }

    // Normalize the structured region. If the caller only sent `location`,
    // treat it as a city string so the region selector still sees the row.
    const canonicalCity =
      normalizeCity(city ?? location ?? undefined) ?? null;
    const canonicalState =
      normalizeState(state ?? undefined) ??
      inferStateFromCity(canonicalCity) ??
      null;

    const existing = await loadExistingByPhone([normalizedPhone]);
    const { outcome, duplicateLeadId } = classifyAgainstExisting(
      canonicalCity ?? "",
      existing.get(normalizedPhone),
    );

    if (outcome !== "valid") {
      // A phone match is reported, never silently resolved. The four outcomes
      // mean different things to the operator and each needs a different next
      // action, so the classification is handed back rather than flattened
      // into one "duplicate" message.
      return NextResponse.json(
        {
          success: false,
          outcome,
          duplicateLeadId,
          error:
            outcome === "reactivate"
              ? "This dealer already exists and is marked Lost. Reactivate the existing lead instead of creating a new one."
              : outcome === "address_mismatch"
                ? "This phone belongs to an existing lead registered in a different city. Raise a merge request from the admin queue."
                : "A lead with this phone number already exists.",
        },
        { status: 409 },
      );
    }

    const id = `DL-${Date.now()}-${nanoid(8)}`;

    await db.insert(dealerLeads).values({
      id,
      dealer_name,
      phone: normalizedPhone,
      shop_name: shop_name || null,
      location: location || canonicalCity,
      state: canonicalState,
      city: canonicalCity,
      area: area || null,
      pincode: pincode || null,
      language: language || "hindi",
      current_status: current_status || "new",
      total_attempts: 0,
      final_intent_score: 0,
      follow_up_history: [],
      created_at: new Date(),
    });

    // E-179 central registry — manually captured dealer prospect.
    await recordLeadCapture({
      leadType: "dealer",
      name: dealer_name,
      phone: normalizedPhone,
      sourceChannel: "web",
      sourceTable: "dealer_leads",
      sourceId: id,
    });

    return NextResponse.json({ success: true, id });
  } catch (err: any) {
    // Catch unique constraint violation from DB as a fallback
    if (err.message?.includes("unique") || err.code === "23505") {
      return NextResponse.json(
        { success: false, error: "A lead with this phone number already exists (duplicate)" },
        { status: 409 },
      );
    }
    console.error("[DEALER-LEADS] Create error:", err);
    return NextResponse.json(
      { success: false, error: "Failed to create lead. Please try again." },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
    // Cap raised to 500 so the AI Dialer can fetch the full lead pool in
    // one request (typical workspace has <500 dialable leads). Paginated
    // table views still pass limit=10 explicitly.
    const limit = Math.min(500, parseInt(searchParams.get("limit") ?? "10"));
    const search = searchParams.get("search")?.trim() ?? "";
    const offset = (page - 1) * limit;

    // Optional created-at date range (YYYY-MM-DD). Inclusive on both ends —
    // compared on the calendar date so a whole "to" day is included. Drives
    // the Leads page month/range filter (cards, count, and list all share
    // this where clause, so they stay consistent).
    const fromDate = searchParams.get("from")?.trim() ?? "";
    const toDate = searchParams.get("to")?.trim() ?? "";
    const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

    // Only surface leads with a phone — the AI dialer can't do anything with
    // phoneless rows, and the Leads UI's Call button would be dead otherwise.
    const phonePresent = and(
      isNotNull(dealerLeads.phone),
      ne(dealerLeads.phone, ""),
    );

    const conds: any[] = [phonePresent];
    if (search) {
      conds.push(
        or(
          ilike(dealerLeads.dealer_name, `%${search}%`),
          ilike(dealerLeads.phone, `%${search}%`),
          ilike(dealerLeads.location, `%${search}%`),
          ilike(dealerLeads.shop_name, `%${search}%`),
        ),
      );
    }
    if (ISO_DATE_RE.test(fromDate)) {
      conds.push(sql`${dealerLeads.created_at}::date >= ${fromDate}`);
    }
    if (ISO_DATE_RE.test(toDate)) {
      conds.push(sql`${dealerLeads.created_at}::date <= ${toDate}`);
    }
    const where = and(...conds);

    const [rows, countResult, statsResult] = await Promise.all([
      db
        .select()
        .from(dealerLeads)
        .where(where)
        .orderBy(desc(dealerLeads.created_at))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)` })
        .from(dealerLeads)
        .where(where),
      // Stats panel: hot/warm/qualified/scheduled counts across ALL matching
      // leads (not just the current page). The page used to filter the
      // visible 10 rows in JS, so every card read 0 unless a high-intent
      // lead happened to be on page 1. Single query, all four counters.
      db
        .select({
          hot: sql<number>`count(*) filter (where ${dealerLeads.current_status} = 'hot')`,
          warm: sql<number>`count(*) filter (where ${dealerLeads.current_status} = 'warm')`,
          qualified: sql<number>`count(*) filter (where ${dealerLeads.current_status} = 'qualified')`,
          scheduled: sql<number>`count(*) filter (where ${dealerLeads.next_call_at} is not null)`,
        })
        .from(dealerLeads)
        .where(where),
    ]);

    // NeoDove sync state for the rows on this page, so the per-row button can
    // render "Sent" after a reload instead of resetting to "NeoDove".
    //
    // Read in a SEPARATE statement that is allowed to fail, and with
    // `neodove_sync_status` named only in the projection. The column is
    // deliberately absent from schema.ts (E-224): naming it on the object
    // would expand every bare `db.select().from(dealerLeads)` in the codebase
    // into an explicit column list and hard-fail ~20 call sites on any DB
    // without the migration. A missing column fails at PARSE time, so this
    // cannot be folded into the main query either — it would take the whole
    // leads list down. Caught and degraded to "nothing is synced", which is
    // the same shape as the truth on a DB where the integration isn't live.
    const neodoveStatus: Record<string, string> = {};
    const pageIds = rows.map((l) => l.id).filter(Boolean) as string[];
    if (pageIds.length) {
      try {
        const synced = await db
          .select({
            id: dealerLeads.id,
            status: sql<string | null>`neodove_sync_status`,
          })
          .from(dealerLeads)
          .where(inArray(dealerLeads.id, pageIds));
        for (const r of synced) {
          if (r.status) neodoveStatus[r.id] = r.status;
        }
      } catch {
        // E-224 not applied here — leave the map empty.
      }
    }

    return NextResponse.json({
      success: true,
      leads: rows.map((l) => ({
        ...l,
        _source: "dealer",
        neodove_sync_status: neodoveStatus[l.id] ?? null,
      })),
      total: Number(countResult[0].count),
      stats: {
        hot: Number(statsResult[0]?.hot ?? 0),
        warm: Number(statsResult[0]?.warm ?? 0),
        qualified: Number(statsResult[0]?.qualified ?? 0),
        scheduled: Number(statsResult[0]?.scheduled ?? 0),
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 },
    );
  }
}
