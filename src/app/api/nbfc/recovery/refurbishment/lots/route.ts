/**
 * E-270 — /api/nbfc/recovery/refurbishment/lots (NBFC side)
 *
 *   GET   — the tenant's lots, `?status=open|closed|all|<status>` (default open)
 *   POST  — send a batch: `{ battery_ids: uuid[], note? }` → one lot, one job
 *           per battery, admin notified.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientError, validationError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { createLot, listLots } from "@/lib/nbfc/recovery/refurbishment-lots";
import { LOT_STATUSES } from "@/lib/nbfc/recovery/refurbishment-lot-status";
import { notifyRefurbRequested } from "@/lib/nbfc/recovery/refurbish-notify";

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
    battery_ids: z.array(z.string().uuid()).min(1).max(100),
    note: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    const url = new URL(req.url);
    const raw = url.searchParams.get("status") ?? "open";
    const status = ([...LOT_STATUSES, "open", "closed", "all"] as string[]).includes(raw)
      ? (raw as Parameters<typeof listLots>[0]["status"])
      : "open";
    const result = await listLots({ tenant_id: actor.tenant_id, status });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(e) }, { status: statusFromError(msg) });
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: validationError(parsed.error), issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const lot = await createLot({
      tenant_id: actor.tenant_id,
      actor_user_id: actor.user_id ?? null,
      battery_ids: parsed.data.battery_ids,
      note: parsed.data.note ?? null,
    });
    await notifyRefurbRequested(lot);
    return NextResponse.json({ ok: true, lot }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(e) }, { status: statusFromError(msg) });
  }
}
