/**
 * POST /api/nbfc/auction/audience/preview
 *
 * "How many dealers will see this?" — answered BEFORE publish.
 *
 * `resolveAuctionAudience()` is a pure read that has only ever been called from
 * inside `freezeAudience()`, i.e. at the moment of publishing, which is the one
 * moment the answer is no longer useful: publishing freezes the audience, and
 * an operator who discovers their radius reached four dealers has already
 * committed. This exposes the same resolver as a dry run. It writes nothing.
 *
 * It deliberately returns COUNTS, not names. The seller learns the size and
 * shape of the reach they are buying; they do not get a dealer list they never
 * had before, and would not get from the published lot either.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import {
  resolveAuctionAudience,
  cityCentroid,
  VISIBILITY_SCOPES,
  type VisibilityRule,
} from "@/lib/nbfc/auction/audience";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

/** Mirrors the publish route's visibility schema exactly — same rules, same
 *  error messages, so a preview that passes cannot fail at publish. */
const VisibilityBody = z
  .object({
    scope: z.enum(VISIBILITY_SCOPES),
    states: z.array(z.string().trim().min(1)).max(40).optional(),
    cities: z.array(z.string().trim().min(1)).max(200).optional(),
    centre_lat: z.number().min(-90).max(90).optional(),
    centre_lng: z.number().min(-180).max(180).optional(),
    radius_km: z.number().int().positive().max(2000).optional(),
    /**
     * Preview-only convenience: name the centre and let the server find it.
     *
     * The publish route needs explicit coordinates, but `cityCentroid()` — the
     * lookup that produces them — is server-side, and the alternative was
     * asking an operator to type a latitude. The resolved pair comes back in
     * the response for the composer to submit at publish, so the coordinates
     * that were previewed are exactly the coordinates that get frozen.
     */
    centre_city: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.scope !== "radius" ||
      v.centre_city != null ||
      (v.centre_lat != null && v.centre_lng != null),
    { message: "radius scope needs a centre — a city name or a lat/lng pair" },
  )
  .refine(
    (v) => v.scope !== "radius" || v.radius_km != null,
    { message: "radius scope needs radius_km" },
  )
  .refine((v) => v.scope !== "state" || (v.states?.length ?? 0) > 0, {
    message: "state scope needs at least one state",
  })
  .refine((v) => v.scope !== "city" || (v.cities?.length ?? 0) > 0, {
    message: "city scope needs at least one city",
  });

export async function POST(req: NextRequest) {
  try {
    await resolveActor(req.headers);

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }

    const parsed = VisibilityBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const { centre_city, ...rule } = parsed.data;

    // Resolve a named centre into coordinates, and hand them back so the
    // composer publishes the same point it previewed.
    let centre: { lat: number; lng: number } | null = null;
    if (rule.scope === "radius") {
      if (rule.centre_lat != null && rule.centre_lng != null) {
        centre = { lat: rule.centre_lat, lng: rule.centre_lng };
      } else if (centre_city) {
        centre = cityCentroid(centre_city);
        if (!centre) {
          return NextResponse.json(
            {
              ok: false,
              error: `BAD_REQUEST: no coordinates on file for "${centre_city}" — pick another centre or enter a lat/lng`,
            },
            { status: 400 },
          );
        }
      }
    }

    const members = await resolveAuctionAudience({
      ...rule,
      centre_lat: centre?.lat ?? rule.centre_lat,
      centre_lng: centre?.lng ?? rule.centre_lng,
    } as VisibilityRule);

    // Shape, not identity. A count of one is worth surfacing loudly in the UI;
    // so is a radius whose nearest dealer is 140 km away.
    const byState = new Map<string, number>();
    for (const m of members) {
      const key = m.state?.trim() || "unknown";
      byState.set(key, (byState.get(key) ?? 0) + 1);
    }
    const distances = members
      .map((m) => m.distance_km)
      .filter((d): d is number => d != null);

    return NextResponse.json({
      ok: true,
      dealer_count: members.length,
      /** Echoed so publish can freeze exactly what was previewed. */
      resolved_centre: centre,
      by_state: [...byState.entries()]
        .map(([state, count]) => ({ state, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 12),
      nearest_km: distances.length > 0 ? Math.min(...distances) : null,
      farthest_km: distances.length > 0 ? Math.max(...distances) : null,
      // Dealers with no city on file are invisible to city and radius scopes.
      // Saying so is the difference between "nobody is there" and "nobody has
      // an address on file", which are very different problems.
      without_city: members.filter((m) => !m.city).length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
