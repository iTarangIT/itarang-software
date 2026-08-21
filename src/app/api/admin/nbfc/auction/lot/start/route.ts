/**
 * [E-256] — POST /api/admin/nbfc/auction/lot/start
 *
 * The action the Auction Control Centre never had: MAKE a lot run.
 *
 * Every other admin endpoint under /lot operates on an auction that is already
 * going. Starting one belonged exclusively to the seller NBFC's composer, so a
 * draft whose seller never came back — including the ones auto-seeded when a
 * battery reaches `ready_for_auction` on the recovery board — sat there with an
 * admin able to cancel it but not to open it.
 *
 * Two shapes of request, decided by the lot's own status, not by the caller:
 *   draft      → needs duration_hours + visibility. Publishes on the seller's
 *                behalf: freezes the audience, opens (or schedules) the lot.
 *   scheduled  → needs neither. Brings the opening forward, carrying ends_at
 *                with it so the promised window is preserved.
 *
 * A paused lot is refused and pointed at /resume, which gives back the time it
 * sat frozen; starting it here would reset a live market's clock.
 *
 * 200 → StartAuctionResult
 * 400 → empty reason / draft missing duration or visibility / malformed body
 * 401 → not signed in
 * 403 → not an admin
 * 404 → lot_id does not exist
 * 409 → lot is live/ended/cancelled/paused, has no seller NBFC, or the
 *       visibility rule reaches no dealers
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { clientError } from "@/lib/nbfc/http-error";
import {
  resolveAdminActor,
  statusFromError,
  ADMIN_ROLES,
} from "@/lib/nbfc/admin/auth";
import { startAuction } from "@/lib/nbfc/admin/auctionControlService";
import { AUCTION_DURATIONS_HOURS } from "@/lib/nbfc/auction/composeLot";
import {
  VISIBILITY_SCOPES,
  AUDIENCE_CHANNELS,
  cityCentroid,
} from "@/lib/nbfc/auction/audience";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mirrors the seller's own publish route field for field. The per-scope refines
// are repeated here rather than left to the resolver so the admin gets told
// which field is missing instead of a generic 400 from three layers down.
const Visibility = z
  .object({
    scope: z.enum(VISIBILITY_SCOPES),
    states: z.array(z.string().trim().min(1)).max(40).optional(),
    cities: z.array(z.string().trim().min(1)).max(200).optional(),
    centre_lat: z.number().min(-90).max(90).optional(),
    centre_lng: z.number().min(-180).max(180).optional(),
    // The admin surface has no audience-preview endpoint to resolve a city into
    // a centroid for it (the seller's composer does), so the centre may arrive
    // as a city NAME and is resolved below. Coordinates still win if both come.
    centre_city: z.string().trim().min(1).max(120).optional(),
    radius_km: z.number().int().positive().max(2000).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.scope !== "radius" ||
      (v.radius_km != null &&
        ((v.centre_lat != null && v.centre_lng != null) ||
          v.centre_city != null)),
    {
      message:
        "radius scope needs radius_km plus either centre_city or centre_lat + centre_lng",
    },
  )
  .refine((v) => v.scope !== "state" || (v.states?.length ?? 0) > 0, {
    message: "state scope needs at least one state",
  })
  .refine((v) => v.scope !== "city" || (v.cities?.length ?? 0) > 0, {
    message: "city scope needs at least one city",
  });

const RequestBody = z
  .object({
    lot_id: z.string().uuid(),
    reason: z.string().min(1),
    // Draft-only. Optional at this layer because a scheduled lot legitimately
    // sends neither; the service refuses a draft that omits them.
    duration_hours: z
      .union([z.literal(2), z.literal(12), z.literal(24), z.literal(48)])
      .optional(),
    visibility: Visibility.optional(),
    channels: z.array(z.enum(AUDIENCE_CHANNELS)).min(1).optional(),
  })
  .strict();

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveAdminActor(req.headers);
    if (!(ADMIN_ROLES as readonly string[]).includes(actor.role)) {
      throw new Error("FORBIDDEN: not an admin");
    }

    let raw: unknown;
    try {
      const text = await req.text();
      raw = text ? JSON.parse(text) : {};
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }

    const parsed = RequestBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: "VALIDATION",
          issues: parsed.error.issues,
          allowed_durations: AUCTION_DURATIONS_HOURS,
        },
        { status: 400 },
      );
    }

    // A city name becomes a centroid here, before the rule is frozen against
    // the lot — `auction_lot_visibility` stores coordinates, and a rule saved
    // with a name and no centre is a rule nobody can re-evaluate later.
    let visibility = parsed.data.visibility;
    if (
      visibility?.scope === "radius" &&
      (visibility.centre_lat == null || visibility.centre_lng == null)
    ) {
      const centre = cityCentroid(visibility.centre_city);
      if (!centre) {
        return NextResponse.json(
          {
            ok: false,
            error: `BAD_REQUEST: no centre found for city "${visibility.centre_city}"`,
          },
          { status: 400 },
        );
      }
      visibility = {
        ...visibility,
        centre_lat: centre.lat,
        centre_lng: centre.lng,
      };
    }

    const result = await startAuction({
      lot_id: parsed.data.lot_id,
      reason: parsed.data.reason,
      actor_user_id: actor.user_id,
      duration_hours: parsed.data.duration_hours,
      visibility,
      channels: parsed.data.channels,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
