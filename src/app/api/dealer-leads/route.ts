import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { inArray, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth-utils";
import { withErrorHandler } from "@/lib/api-utils";
import { LEADS_PAGE_ROLES, capabilitiesFor } from "@/lib/leads/access";
import { isIntentBucket } from "@/lib/leads/intentBucket";
import {
  BULK_ID_CAP,
  fetchLeadListFacets,
  fetchLeadListIds,
  fetchLeadListRows,
  fetchLeadListStats,
  type LeadListFilters,
  type LeadListRow,
} from "@/lib/leads/leadListQuery";
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

// GET — the merged Leads list.
//
// This is the single endpoint behind /leads → "Leads" tab, which used to be two
// screens: this one, and /admin/leads-info. They read the same `dealer_leads`
// table but disagreed — /leads filtered `phone IS NOT NULL` (and let
// soft-deleted rows through) and showed `current_status`; Leads Info filtered
// `is_active IS NOT FALSE` and showed `lead_status`. The same lead therefore
// read "New" on one page and "— no status" on the other. The query now lives in
// src/lib/leads/leadListQuery.ts and both pages resolve to this one list.
export const GET = withErrorHandler(async (req: Request) => {
  // ⚠ SECURITY: there was NO auth check here of any kind before the merge, and
  // middleware does not gate /api/*. /leads also matches no `roleDashboards`
  // prefix and is absent from `sharedRouteAccess`, so the "wrong role → bounce"
  // check never fired for it either — meaning any signed-in user of any role
  // (dealer, nbfc_partner, scrap_vendor…) could read every prospect's name and
  // phone. See src/lib/leads/access.ts.
  const user = await requireRole([...LEADS_PAGE_ROLES]);
  const caps = capabilitiesFor(user.role);

  const searchParams = new URL(req.url).searchParams;
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1") || 1);
  // Cap left at 500 deliberately. The comment that used to sit here claimed the
  // AI Dialer needed it to fetch the whole pool in one request; that is stale
  // (the queue has come from POST /api/ai-dialer/preview → resolveAudience since
  // E-224, and the page's 2s poll re-fetches only the visible 10 rows). The cap
  // is kept purely so no unknown caller starts truncating.
  const limit = Math.min(500, Math.max(1, parseInt(searchParams.get("limit") ?? "25") || 25));

  const intentParam = searchParams.get("intent");
  const filters: LeadListFilters = {
    status: searchParams.get("status") || null,
    intent: isIntentBucket(intentParam) ? intentParam : null,
    source: searchParams.get("source") || null,
    state: searchParams.get("state")?.trim() || null,
    city: searchParams.get("city")?.trim() || null,
    search: searchParams.get("search")?.trim() || null,
    from: searchParams.get("from")?.trim() || null,
    to: searchParams.get("to")?.trim() || null,
    hasPhone: searchParams.get("has_phone") === "1",
    // Owner / ASM are oversight-only (they were visible solely on the
    // admin+sales_head-gated Leads Info page). The params are IGNORED rather
    // than merely hidden in the UI, so a hand-crafted request can't filter by a
    // field the caller isn't allowed to see.
    ownerId: caps.canSeeOwnerAsm ? searchParams.get("owner_id") || null : null,
    asmId: caps.canSeeOwnerAsm ? searchParams.get("asm_id") || null : null,
  };

  // ?ids_only=1 — every id matching these filters, for "select all N matching".
  // Returned on its own: the caller wants ids to feed a bulk action, not rows,
  // and materialising 5,000 joined rows (plus the visit LATERAL and both user
  // joins) to throw away every column but one would be pure waste.
  if (searchParams.get("ids_only") === "1") {
    const ids = await fetchLeadListIds(filters);
    return NextResponse.json({
      success: true,
      ids,
      // True when there were more matches than the bulk endpoint can accept, so
      // the UI can say the selection was capped instead of quietly short-changing
      // it. See BULK_ID_CAP.
      capped: ids.length >= BULK_ID_CAP,
      cap: BULK_ID_CAP,
    });
  }

  const [rows, stats, allFacets] = await Promise.all([
    fetchLeadListRows(filters, page, limit),
    fetchLeadListStats(filters),
    fetchLeadListFacets(),
  ]);

  // Same tiering on the way out: the source list is for everyone, the people
  // lists are not.
  const facets = caps.canSeeOwnerAsm
    ? allFacets
    : { owners: [], asms: [], sources: allFacets.sources };

  // NeoDove sync state for the rows on this page, so the per-row button can
  // render "Sent" after a reload instead of resetting to "NeoDove".
  //
  // ⚠ DO NOT FOLD THIS INTO THE MAIN QUERY. Read in a SEPARATE statement that is
  // allowed to fail, with `neodove_sync_status` named only in the projection.
  // The column is deliberately absent from schema.ts (E-224): naming it on the
  // object would expand every bare `db.select().from(dealerLeads)` in the
  // codebase into an explicit column list and hard-fail ~20 call sites on any DB
  // without the migration. A missing column fails at PARSE time, so folding it
  // in would take the whole leads list down on those DBs. Caught and degraded to
  // "nothing is synced", which is the same shape as the truth there.
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

  const maskOversight = (l: LeadListRow) =>
    caps.canSeeOwnerAsm
      ? l
      : {
          ...l,
          current_owner_id: null,
          current_owner_name: null,
          current_owner_role: null,
          asm_id: null,
          asm_name: null,
        };

  return NextResponse.json({
    success: true,
    leads: rows.map((l) => ({
      ...maskOversight(l),
      _source: "dealer",
      neodove_sync_status: neodoveStatus[l.id] ?? null,
    })),
    total: stats.total,
    stats: {
      hot: stats.hot,
      warm: stats.warm,
      cold: stats.cold,
      unassigned: stats.unassigned,
      scheduled: stats.scheduled,
      // Retained for one release so a cached client bundle that still reads
      // stats.qualified doesn't render undefined. It is exactly the Hot count:
      // leadStatusFor() classifies `qualified` as score >= INTENT_THRESHOLDS
      // .QUALIFIED (75), which is the same cut as the Hot bucket. The old card
      // counted `current_status = 'hot'`, which no code path ever writes
      // (leadStore.ts only ever writes qualified/warm/cold/disqualified), so it
      // was structurally near-zero — that bug is what this replaces.
      qualified: stats.hot,
    },
    facets,
    capabilities: caps,
  });
});
