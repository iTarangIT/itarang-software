/**
 * POST /api/ai-dialer/preview
 *
 * Server-side replacement for the modal's old client-side
 * "fetch 500 leads, filter in browser" path. Accepts a region selection
 * (loose states, specific state+city pairs, pincodes, saved group IDs)
 * plus an optional segment category, and returns the bucketed counts
 * (hot/warm/cold/all) plus the queue of dealer_leads.id values to dial.
 *
 * The returned queueIds is what the modal hands to /api/ai-dialer/start,
 * so the modal's "Start dialing" button doesn't need to know anything
 * about the underlying lead set — preview is the source of truth.
 *
 * Region resolution:
 *  - groupIds  → resolved to the union of their `regions` jsonb arrays.
 *  - states[]  → match any row in that state (no city constraint).
 *  - cities[]  → match {state, city} pairs exactly.
 *  - pincodes[] → match any row with that pincode.
 *  Empty selection (no filters) matches every callable lead.
 *
 * Status buckets mirror the modal's bucketOf() logic exactly, so the
 * counts the user sees can't drift from the client.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerLeads, regionGroups } from "@/lib/db/schema";
import { and, inArray, isNotNull, ne, or, eq, sql } from "drizzle-orm";

type RegionEntry = { state: string; cities?: string[] };

const HOT_STATUSES = new Set(["hot", "qualified"]);
const WARM_STATUSES = new Set([
  "warm",
  "callback_requested",
  "contacted",
  "interested",
]);
const NO_CALL_STATUSES = new Set(["converted", "not_interested", "dnc", "blacklisted"]);

function bucketOf(status: string | null | undefined): "hot" | "warm" | "cold" {
  const s = (status ?? "").toLowerCase().trim();
  if (HOT_STATUSES.has(s)) return "hot";
  if (WARM_STATUSES.has(s)) return "warm";
  return "cold";
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      states: rawStates,
      cities: rawCities,
      pincodes: rawPincodes,
      groupIds: rawGroupIds,
      category,
    }: {
      states?: string[];
      cities?: { state: string; city: string }[];
      pincodes?: string[];
      groupIds?: string[];
      category?: "hot" | "warm" | "cold" | "all";
    } = body ?? {};

    const states = Array.isArray(rawStates) ? rawStates.filter((s) => typeof s === "string" && s.trim()) : [];
    const cities = Array.isArray(rawCities)
      ? rawCities.filter(
          (c) =>
            c && typeof c.state === "string" && c.state.trim() &&
            typeof c.city === "string" && c.city.trim(),
        )
      : [];
    const pincodes = Array.isArray(rawPincodes) ? rawPincodes.filter((p) => typeof p === "string" && p.trim()) : [];
    const groupIds = Array.isArray(rawGroupIds) ? rawGroupIds.filter((g) => typeof g === "string" && g) : [];

    // Resolve saved groups → fold into states/cities. Empty cities[] on a
    // group entry means "all cities in this state", so we promote it to
    // states[] instead of cities[].
    if (groupIds.length) {
      const groups = await db
        .select({ regions: regionGroups.regions })
        .from(regionGroups)
        .where(inArray(regionGroups.id, groupIds));
      for (const g of groups) {
        const entries = (g.regions as RegionEntry[] | null) ?? [];
        for (const e of entries) {
          if (!e?.state) continue;
          if (!Array.isArray(e.cities) || e.cities.length === 0) {
            states.push(e.state);
          } else {
            for (const c of e.cities) {
              if (c) cities.push({ state: e.state, city: c });
            }
          }
        }
      }
    }

    // Build the region OR-group. If nothing is selected we fall through to
    // "every callable lead".
    const regionFilters = [] as any[];
    if (states.length) regionFilters.push(inArray(dealerLeads.state, states));
    for (const { state, city } of cities) {
      regionFilters.push(
        and(eq(dealerLeads.state, state), eq(dealerLeads.city, city)),
      );
    }
    if (pincodes.length) regionFilters.push(inArray(dealerLeads.pincode, pincodes));

    const callable = and(
      isNotNull(dealerLeads.phone),
      ne(dealerLeads.phone, ""),
    );

    const where = regionFilters.length
      ? and(callable, or(...regionFilters))
      : callable;

    const rows = await db
      .select({
        id: dealerLeads.id,
        phone: dealerLeads.phone,
        current_status: dealerLeads.current_status,
        final_intent_score: dealerLeads.final_intent_score,
        dealer_name: dealerLeads.dealer_name,
        shop_name: dealerLeads.shop_name,
      })
      .from(dealerLeads)
      .where(where);

    // Tally segments and apply the same NO_CALL filter the modal used to
    // apply client-side. Sort by intent score descending — hot leads dial
    // first within the chosen category.
    const counts = { hot: 0, warm: 0, cold: 0, all: 0 };
    const dialable = [] as typeof rows;
    for (const r of rows) {
      const s = (r.current_status ?? "").toLowerCase().trim();
      if (NO_CALL_STATUSES.has(s)) continue;
      const b = bucketOf(r.current_status);
      counts[b] += 1;
      counts.all += 1;
      dialable.push(r);
    }

    const filtered = (() => {
      if (!category || category === "all") return dialable;
      return dialable.filter((r) => bucketOf(r.current_status) === category);
    })();

    filtered.sort(
      (a, b) => (b.final_intent_score ?? 0) - (a.final_intent_score ?? 0),
    );

    return NextResponse.json({
      success: true,
      counts,
      queueIds: filtered.map((r) => r.id),
      queue: filtered.map((r) => ({
        id: r.id,
        phone: r.phone,
        dealer_name: r.dealer_name,
        shop_name: r.shop_name,
        final_intent_score: r.final_intent_score,
        current_status: r.current_status,
      })),
    });
  } catch (err: any) {
    console.error("[AI DIALER] preview error:", err);
    return NextResponse.json(
      { success: false, error: err.message ?? "Preview failed" },
      { status: 500 },
    );
  }
}
