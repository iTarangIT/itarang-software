/**
 * E-234 — POST /api/nbfc/auction/lots/[id]/publish (BRD §7, §8)
 *
 * Turns a draft into a live (or scheduled) auction: fixes the window, resolves
 * the visibility rule into a FROZEN dealer audience, and hands the lot to the
 * scheduler.
 *
 * This route is the deliberate act that replaced auto-publish. A lot used to
 * reach the marketplace because someone dragged a kanban card; now somebody has
 * to choose a duration, choose who can see it, and press a button.
 *
 * Durations are the four the BRD names — 2 / 12 / 24 / 48 h — validated
 * server-side because the TypeScript union only binds TypeScript callers.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import {
  publishLot,
  AUCTION_DURATIONS_HOURS,
  type AuctionDurationHours,
} from "@/lib/nbfc/auction/composeLot";
import { VISIBILITY_SCOPES, AUDIENCE_CHANNELS } from "@/lib/nbfc/auction/audience";

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

const Body = z
  .object({
    duration_hours: z.union([
      z.literal(2),
      z.literal(12),
      z.literal(24),
      z.literal(48),
    ]),
    starts_at: z.string().datetime().optional(),
    visibility: z
      .object({
        scope: z.enum(VISIBILITY_SCOPES),
        states: z.array(z.string().trim().min(1)).max(40).optional(),
        cities: z.array(z.string().trim().min(1)).max(200).optional(),
        centre_lat: z.number().min(-90).max(90).optional(),
        centre_lng: z.number().min(-180).max(180).optional(),
        radius_km: z.number().int().positive().max(2000).optional(),
      })
      .strict()
      // Caught here as well as in the service so the operator gets a field-level
      // message instead of a generic 400 from deep inside the resolver.
      .refine(
        (v) =>
          v.scope !== "radius" ||
          (v.centre_lat != null && v.centre_lng != null && v.radius_km != null),
        { message: "radius scope needs centre_lat, centre_lng and radius_km" },
      )
      .refine((v) => v.scope !== "state" || (v.states?.length ?? 0) > 0, {
        message: "state scope needs at least one state",
      })
      .refine((v) => v.scope !== "city" || (v.cities?.length ?? 0) > 0, {
        message: "city scope needs at least one city",
      }),
    channels: z.array(z.enum(AUDIENCE_CHANNELS)).min(1).optional(),
  })
  .strict();

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await resolveActor(req.headers);
    const { id } = await ctx.params;

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

    const parsed = Body.safeParse(raw);
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

    const result = await publishLot({
      tenant_id: actor.tenant_id,
      actor_user_id: actor.user_id,
      lot_id: id,
      duration_hours: parsed.data.duration_hours as AuctionDurationHours,
      starts_at: parsed.data.starts_at ?? null,
      visibility: parsed.data.visibility,
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
