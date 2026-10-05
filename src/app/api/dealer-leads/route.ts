import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { inArray, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth-utils";
import { withErrorHandler } from "@/lib/api-utils";
import { LEADS_PAGE_ROLES, capabilitiesFor } from "@/lib/leads/access";
import { parseLeadListFilters } from "@/lib/leads/leadListParams";
import {
  BULK_ID_CAP,
  fetchBusinessTypeCounts,
  fetchBusinessTypeForLeads,
  fetchLeadListFacets,
  fetchLeadListIds,
  fetchLeadListRows,
  fetchLeadListStats,
  type LeadListFilters,
  type LeadListRow,
} from "@/lib/leads/leadListQuery";
import {
  fetchCampaignFacets,
  fetchCampaignForLeads,
  type LeadCampaign,
} from "@/lib/leads/leadCampaign";
import {
  fetchAssignedByForLeads,
  type LeadAssignedBy,
} from "@/lib/leads/leadAssignedBy";
import { nanoid } from "nanoid";
import {
  normalizeCity,
  normalizeState,
  inferStateFromCity,
} from "@/lib/scraper-enrichment";
import { recordLeadCapture } from "@/lib/leads/lead-registry";
import { createdByHandReason, markSalesReady } from "@/lib/leads/salesReady";
import {
  LEAD_ORIGINS,
  recordLeadCreated,
  recordReinquiry,
  stampLeadSource,
  type LeadOrigin,
} from "@/lib/leads/leadSource";
import {
  classifyAgainstExisting,
  loadExistingByPhone,
  normalizePhone,
} from "@/lib/leads/dedupe";
import { CampaignError, resolveLeadCampaign } from "@/lib/leads/acquisitionCampaigns";
import { normalizeBusinessType } from "@/lib/leads/businessType";

export async function POST(req: NextRequest) {
  // ⚠ SECURITY: this create had no auth check (middleware does not gate
  // /api/*), so any signed-in role — or an anonymous POST — could insert a
  // prospect. Same readers as the list below.
  let user;
  try {
    user = await requireRole([...LEADS_PAGE_ROLES]);
  } catch {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }
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
      business_type,
      origin,
      campaign_id,
    } = body;

    if (!dealer_name || !phone) {
      return NextResponse.json(
        { success: false, error: "dealer_name and phone are required" },
        { status: 400 },
      );
    }
    // ID 81: a rep-created lead needs city, business type and origin — source
    // can only be captured at creation, never added properly later.
    if (!String(city ?? location ?? "").trim()) {
      return NextResponse.json({ success: false, error: "City is required." }, { status: 400 });
    }
    if (!String(business_type ?? "").trim()) {
      return NextResponse.json({ success: false, error: "Type of Business is required." }, { status: 400 });
    }
    if (!(LEAD_ORIGINS as readonly string[]).includes(String(origin ?? ""))) {
      return NextResponse.json(
        { success: false, error: "Pick how the dealer was found (Found via)." },
        { status: 400 },
      );
    }
    const leadOrigin = origin as LeadOrigin;

    // E-296 "Type of Business". Optional; tolerant of labels ("Battery Sale")
    // because the /leads xlsx importer posts spreadsheet cells here. A non-blank
    // value that is not in the vocabulary is refused rather than silently
    // dropped — the operator picked something and should know it didn't land.
    const businessTypeRaw =
      business_type == null ? "" : String(business_type).trim();
    const businessType = normalizeBusinessType(businessTypeRaw);
    if (businessTypeRaw && !businessType) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Type of Business must be one of: Battery Sale, Buyback, Finance, Scrap, Other.",
        },
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
      // ID 81: a known dealer arriving again is a Re-inquiry on the existing
      // lead — never a second copy, never a new source.
      if (duplicateLeadId) {
        await recordReinquiry({ leadId: duplicateLeadId, door: "rep_create", actorId: user.id, note: dealer_name });
      }
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

    // ID 81: a Trade event / Digital ad lead needs its campaign, and a campaign
    // that is given must exist and be open. After the duplicate check.
    let campaignId: string | null;
    try {
      campaignId = await resolveLeadCampaign(db, {
        origin: leadOrigin,
        campaignId: typeof campaign_id === "string" ? campaign_id : null,
      });
    } catch (e) {
      if (e instanceof CampaignError) {
        return NextResponse.json({ success: false, error: e.message }, { status: e.status });
      }
      throw e;
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

    // E-296 — business_type is not on the Drizzle object (see schema.ts), so it
    // is written by a raw UPDATE after the insert. Fail-tolerant: on a database
    // without the migration the lead still exists, and the response says the
    // type did not save instead of failing a create that already happened.
    let businessTypeSaved = true;
    if (businessType) {
      try {
        await db.execute(
          sql`UPDATE dealer_leads SET business_type = ${businessType} WHERE id = ${id}`,
        );
      } catch (e) {
        businessTypeSaved = false;
        console.warn("[DEALER-LEADS] business_type not saved (E-296 applied?):", e);
      }
    }

    // ID 81: Entered via = Rep-created, Found via = what the rep picked, and
    // the "Lead created" event. Best-effort — the lead exists either way.
    await stampLeadSource(db, id, { door: "rep_create", origin: leadOrigin, campaignId });
    try {
      await recordLeadCreated(db, { leadId: id, actorId: user.id, door: "rep_create", ownerId: null });
    } catch (e) {
      console.warn("[DEALER-LEADS] Lead created not recorded:", e);
    }

    // ID 82: a lead a person created by hand is sales-ready from creation — the
    // same event the Inside Sales / ASM form and the Assistant write. Without
    // it the lead never reached Ready to assign. Best-effort (never throws).
    await markSalesReady(db, { leadId: id, reason: createdByHandReason(leadOrigin), actorId: user.id });

    // E-179 central registry — manually captured dealer prospect.
    await recordLeadCapture({
      leadType: "dealer",
      name: dealer_name,
      phone: normalizedPhone,
      sourceChannel: "web",
      sourceTable: "dealer_leads",
      sourceId: id,
    });

    return NextResponse.json({
      success: true,
      id,
      ...(businessType ? { business_type_saved: businessTypeSaved } : {}),
    });
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

  // ONE reader for the list and both exports (src/lib/leads/leadListParams.ts):
  // the export routes say they parse "exactly as GET", and now they literally
  // do — including the ID 36 "Hide dead & disqualified" toggle (hide_dead=0
  // shows them) and the contactability filter. Owner / ASM / assigned-date stay
  // gated on caps.canSeeOwnerAsm there. Passing `user` scopes a rep role
  // (asm, inside_sales_rep, partner) to the leads it owns — ID 45: a rep cannot
  // browse the pool here, in ids_only, or in the stats.
  const filters: LeadListFilters = await parseLeadListFilters(searchParams, caps, user);

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

  const [rows, stats, allFacets, campaignFacets, businessTypeCounts] =
    await Promise.all([
      fetchLeadListRows(filters, page, limit),
      fetchLeadListStats(filters),
      fetchLeadListFacets(),
      fetchCampaignFacets(),
      // Per-type chips (E-296). null when the column does not exist here.
      fetchBusinessTypeCounts(filters),
    ]);

  // Same tiering on the way out: the source list is for everyone, the people
  // lists are not. Campaigns go with the source list — which campaign a lead is
  // in is a property of the lead, not of the reporting structure.
  const facets = caps.canSeeOwnerAsm
    ? { ...allFacets, campaigns: campaignFacets }
    : {
        owners: [],
        asms: [],
        sources: allFacets.sources,
        dispositions: allFacets.dispositions,
        campaigns: campaignFacets,
      };

  // NeoDove sync state and the latest call disposition for the rows on this
  // page, so the per-row button can render "Sent" after a reload instead of
  // resetting to "NeoDove", and so the disposition being filtered on is visible
  // on the row that matched it.
  //
  // ⚠ DO NOT FOLD THIS INTO THE MAIN QUERY. Read in a SEPARATE statement that is
  // allowed to fail, with the columns named only in the projection. They are
  // deliberately absent from schema.ts (E-224, E-236): naming them on the object
  // would expand every bare `db.select().from(dealerLeads)` in the codebase into
  // an explicit column list and hard-fail ~20 call sites on any DB without the
  // migration. A missing column fails at PARSE time, so folding it in would take
  // the whole leads list down on those DBs. Caught and degraded to "nothing is
  // synced and nothing is dispositioned", which is the same shape as the truth
  // there.
  //
  // E-224 and E-236 are separate statements because they can be applied
  // independently: one try/catch would let a database with E-224 but not E-236
  // lose its sync badges too.
  // Campaign membership for this page's rows — same decoration pattern, and
  // fail-tolerant for the same reason (see fetchCampaignForLeads).
  let campaigns: Record<string, LeadCampaign> = {};
  // Who handed each lead to its current owner. Oversight information, exposed
  // on the same terms as the Owner / ASM columns — see maskOversight below.
  let assignedBy: Record<string, LeadAssignedBy> = {};

  // E-296 business_type for this page — separate, fail-tolerant statement.
  let businessTypes: Record<string, string | null> = {};

  const neodoveStatus: Record<string, string> = {};
  const dispositions: Record<
    string,
    { label: string; bucket: string | null; connectStatus: string | null }
  > = {};
  const pageIds = rows.map((l) => l.id).filter(Boolean) as string[];
  if (pageIds.length) {
    campaigns = await fetchCampaignForLeads(pageIds);
    businessTypes = await fetchBusinessTypeForLeads(pageIds);
    // Only fetched for roles allowed to see it — a request that cannot render
    // the stamp should not pay for the query either.
    if (caps.canSeeOwnerAsm) {
      assignedBy = await fetchAssignedByForLeads(pageIds);
    }

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

    try {
      const disposed = await db
        .select({
          id: dealerLeads.id,
          label: sql<string | null>`last_disposition`,
          bucket: sql<string | null>`last_disposition_bucket`,
          connectStatus: sql<string | null>`last_connect_status`,
        })
        .from(dealerLeads)
        .where(inArray(dealerLeads.id, pageIds));
      for (const r of disposed) {
        if (r.label) {
          dispositions[r.id] = {
            label: r.label,
            bucket: r.bucket,
            connectStatus: r.connectStatus,
          };
        }
      }
    } catch {
      // E-236 not applied here — leave the map empty.
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
      campaign: campaigns[l.id] ?? null,
      // Suppressed for non-oversight roles alongside owner/asm — naming the
      // person who assigned a lead discloses the same reporting structure the
      // Owner column does, so it cannot be the one field that leaks it.
      // `assignedBy` is already empty for those roles; this is the second lock.
      assigned_by: caps.canSeeOwnerAsm ? (assignedBy[l.id] ?? null) : null,
      last_disposition: dispositions[l.id]?.label ?? null,
      last_disposition_bucket: dispositions[l.id]?.bucket ?? null,
      last_connect_status: dispositions[l.id]?.connectStatus ?? null,
      business_type: businessTypes[l.id] ?? null,
    })),
    total: stats.total,
    // { battery_sale: n, …, unset: n } under the current filters minus
    // business_type; null when E-296 is not applied here.
    business_type_counts: businessTypeCounts,
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
