/**
 * E-234 — who can see a lot (Battery Auction BRD §8, §9, §17).
 *
 * One visibility rule per lot (india | state | city | radius) resolved ONCE at
 * publish into `auction_lot_audience`, then frozen.
 *
 * WHY FROZEN
 *   A dealer who was notified must keep seeing the lot they were told about,
 *   and a dealer who onboards mid-auction must not silently join a race that is
 *   half over. Re-running the rule on every read makes the audience a moving
 *   target and makes "who did we tell?" unanswerable afterwards — which is the
 *   question a disputed auction turns on.
 *
 * THE RULE THAT MATTERS MOST
 *   Eligibility is DEALER-ONLY, and the exclusion of NBFC users is by ROLE, not
 *   by geography (see roles.ts). Geography only ever NARROWS an already-dealer
 *   audience. Get that backwards and a city-scoped lot leaks to a competitor
 *   NBFC who happens to sit inside the circle — and it leaks invisibly, because
 *   the lot looks correctly targeted.
 */
import { db } from "@/lib/db";
import { and, eq, sql } from "drizzle-orm";
import {
  accounts,
  auctionLotAudience,
  auctionLotVisibility,
} from "@/lib/db/schema";

export const VISIBILITY_SCOPES = ["india", "state", "city", "radius"] as const;
export type VisibilityScope = (typeof VISIBILITY_SCOPES)[number];

export interface VisibilityRule {
  scope: VisibilityScope;
  states?: string[];
  cities?: string[];
  centre_lat?: number | null;
  centre_lng?: number | null;
  radius_km?: number | null;
}

export interface AudienceMember {
  dealer_id: string;
  dealer_name: string | null;
  city: string | null;
  state: string | null;
  distance_km: number | null;
}

/** Channels a published lot fans out over (BRD §17). */
export const AUDIENCE_CHANNELS = ["in_app", "whatsapp", "email", "sms"] as const;
export type AudienceChannel = (typeof AUDIENCE_CHANNELS)[number];

// ---------------------------------------------------------------------------
// City centroids
// ---------------------------------------------------------------------------
// `accounts` stores city/state/pincode and NO coordinates, so a radius rule has
// nothing exact to measure against. Rather than drop the scope or add a
// geocoding dependency, distance is measured to the CITY CENTROID. The index
// and the maths now live in src/lib/geo/city-centroid.ts (shared with the risk
// engine's "outside assigned city" card); re-exported here so the auction
// routes that import them from this module are unchanged.
//
// This is approximate by construction and the approximation is stated wherever
// the number is shown: a dealer is "in" a 25 km radius if their city's centre
// is, which is right for a rule whose purpose is "roughly near this warehouse"
// and wrong for anything that needs metres. It is not silently precise.
import { cityCentroid, haversineKm, normaliseCity } from "@/lib/geo/city-centroid";
export { cityCentroid, haversineKm };

/**
 * Resolves the eligible dealer audience for a visibility rule.
 *
 * The SQL half enforces the non-negotiable part — an active, onboarding-approved
 * dealer account — and the geography is applied on top. A dealer with no city on
 * file is included by `india` and `state` (where the state matches) but excluded
 * by `city` and `radius`, because those two cannot be evaluated without one and
 * guessing would put a dealer in Kerala into a Pune pallet's audience.
 */
export async function resolveAuctionAudience(
  rule: VisibilityRule,
): Promise<AudienceMember[]> {
  const rows = await db
    .select({
      id: accounts.id,
      name: accounts.business_entity_name,
      city: accounts.city,
      state: accounts.state,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.status, "active"),
        eq(accounts.onboarding_status, "approved"),
      ),
    );

  const wantedStates = new Set(
    (rule.states ?? []).map((s) => s.trim().toLowerCase()),
  );
  const wantedCities = new Set(
    (rule.cities ?? []).map((c) => normaliseCity(c)),
  );

  const out: AudienceMember[] = [];
  for (const r of rows) {
    const city = r.city ?? null;
    const state = r.state ?? null;
    let distance: number | null = null;

    switch (rule.scope) {
      case "india":
        break;

      case "state": {
        if (!state || !wantedStates.has(state.trim().toLowerCase())) continue;
        break;
      }

      case "city": {
        if (!city || !wantedCities.has(normaliseCity(city))) continue;
        break;
      }

      case "radius": {
        const centreLat = Number(rule.centre_lat);
        const centreLng = Number(rule.centre_lng);
        const radius = Number(rule.radius_km);
        if (
          !Number.isFinite(centreLat) ||
          !Number.isFinite(centreLng) ||
          !Number.isFinite(radius) ||
          radius <= 0
        ) {
          throw new Error(
            "BAD_REQUEST: radius visibility needs centre_lat, centre_lng and a positive radius_km",
          );
        }
        const centroid = cityCentroid(city);
        // No city, or a city this dataset does not know: excluded. Including
        // them would mean "we could not tell, so we told everyone", which is
        // the opposite of what a radius rule is for.
        if (!centroid) continue;
        distance = haversineKm(centreLat, centreLng, centroid.lat, centroid.lng);
        if (distance > radius) continue;
        distance = Math.round(distance * 100) / 100;
        break;
      }
    }

    out.push({
      dealer_id: r.id,
      dealer_name: r.name ?? null,
      city,
      state,
      distance_km: distance,
    });
  }

  // Nearest first for radius, alphabetical otherwise — so the frozen row order
  // is stable and a reviewer reading the audience sees it grouped sensibly.
  out.sort((a, b) => {
    if (a.distance_km !== null && b.distance_km !== null) {
      return a.distance_km - b.distance_km;
    }
    return (a.dealer_name ?? "").localeCompare(b.dealer_name ?? "");
  });

  return out;
}

/**
 * Writes the visibility rule and freezes the resolved audience, one row per
 * (lot, dealer, channel).
 *
 * `onConflictDoNothing` on both writes makes re-publishing a lot idempotent
 * rather than a unique violation, and — more importantly — it means a re-publish
 * never resets `status` on a row that has already been sent. A dealer must not
 * be notified twice because someone clicked publish again.
 */
export async function freezeAudience(input: {
  lot_id: string;
  rule: VisibilityRule;
  channels?: AudienceChannel[];
}): Promise<{ dealer_count: number; row_count: number }> {
  const channels = input.channels ?? [...AUDIENCE_CHANNELS];
  const members = await resolveAuctionAudience(input.rule);

  await db.transaction(async (tx) => {
    await tx
      .insert(auctionLotVisibility)
      .values({
        lot_id: input.lot_id,
        scope: input.rule.scope,
        states: input.rule.states ?? [],
        cities: input.rule.cities ?? [],
        centre_lat:
          input.rule.centre_lat != null ? String(input.rule.centre_lat) : null,
        centre_lng:
          input.rule.centre_lng != null ? String(input.rule.centre_lng) : null,
        radius_km: input.rule.radius_km ?? null,
      })
      .onConflictDoNothing({ target: auctionLotVisibility.lot_id });

    if (members.length > 0) {
      const rows = members.flatMap((m) =>
        channels.map((channel) => ({
          lot_id: input.lot_id,
          dealer_id: m.dealer_id,
          dealer_name: m.dealer_name,
          city: m.city,
          state: m.state,
          distance_km: m.distance_km != null ? String(m.distance_km) : null,
          channel,
          status: "pending",
        })),
      );
      // Chunked: one lot with a country-wide audience across four channels is
      // thousands of rows, and postgres-js binds every value as a parameter.
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        await tx
          .insert(auctionLotAudience)
          .values(rows.slice(i, i + CHUNK))
          .onConflictDoNothing();
      }
    }
  });

  return { dealer_count: members.length, row_count: members.length * channels.length };
}

/** True when this dealer was in the frozen audience for this lot. */
export async function isDealerInAudience(
  lot_id: string,
  dealer_id: string,
): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`1` })
    .from(auctionLotAudience)
    .where(
      and(
        eq(auctionLotAudience.lot_id, lot_id),
        eq(auctionLotAudience.dealer_id, dealer_id),
      ),
    )
    .limit(1);
  return Boolean(row);
}
