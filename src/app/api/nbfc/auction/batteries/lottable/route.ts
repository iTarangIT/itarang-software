/**
 * GET /api/nbfc/auction/batteries/lottable
 *
 * The lot composer's battery picker.
 *
 * `listLottableBatteries()` has existed in `recovery/battery.ts` since E-232
 * with no route to reach it, so the only way to find pickable stock was two
 * calls to `/api/nbfc/recovery/batteries` (`?state=ready` then
 * `?state=inspected`, because that query param takes one value) and a merge in
 * the browser. This is the one call, and it returns the numbers the picker
 * actually shows: the derived price and the state of health, which otherwise
 * only appear after the lot is composed.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { listLottableBatteries } from "@/lib/nbfc/recovery/battery";
import { buildLotFacts } from "@/lib/nbfc/auction/composeLot";

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

const Query = z.object({
  /** Free text over serial, model and warehouse. */
  q: z.string().trim().min(1).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    const parsed = Query.safeParse(
      Object.fromEntries(new URL(req.url).searchParams),
    );
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const all = await listLottableBatteries(actor.tenant_id);

    const q = parsed.data.q?.toLowerCase();
    const rows = q
      ? all.filter((b) =>
          [b.serial, b.model, b.warehouse, b.city]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(q)),
        )
      : all;

    // The same derivation the composer will apply, so the price the operator
    // sees in the picker is the price the lot is built from — not an estimate
    // that shifts once they press Add.
    const facts = await buildLotFacts(
      rows.map((b) => ({
        id: b.id,
        serial: b.serial,
        condition_grade: b.condition_grade,
        capacity: b.capacity,
      })),
    );
    const byId = new Map(facts.items.map((i) => [i.battery_id, i]));

    return NextResponse.json({
      ok: true,
      items: rows.map((b) => ({
        battery_id: b.id,
        serial: b.serial,
        model: b.model,
        capacity: b.capacity,
        condition_grade: b.condition_grade,
        state_code: b.state_code,
        warehouse: b.warehouse,
        city: b.city,
        state: b.state,
        image_url: b.image_urls[0] ?? null,
        photo_count: b.image_urls.length,
        derived_price: byId.get(b.id)?.item_price ?? null,
        soh: byId.get(b.id)?.soh ?? null,
      })),
      total: rows.length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
