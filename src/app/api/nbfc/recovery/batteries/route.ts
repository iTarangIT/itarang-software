/**
 * E-232 — /api/nbfc/recovery/batteries (Battery Auction BRD §3)
 *
 * GET  — list the caller tenant's recovered batteries, filterable by state,
 *        warehouse and free text over serial/model.
 * POST — register a physical battery arriving at a collection centre.
 *
 * AuthN/Z: `resolveActor` — an NBFC session, scoped to its own tenant. A
 * battery already registered to a different NBFC is refused by the service
 * with a CONFLICT rather than a unique-violation stack trace.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import {
  BATTERY_STATES,
  batteryCounts,
  createRecoveryBattery,
  listBatteries,
} from "@/lib/nbfc/recovery/battery";

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
  state: z.enum([...BATTERY_STATES, "all"]).default("all"),
  warehouse: z.string().trim().min(1).optional(),
  q: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

const Body = z
  .object({
    serial: z.string().trim().min(1).max(64),
    model: z.string().trim().max(120).optional(),
    capacity: z.string().trim().max(32).optional(),
    manufacturing_date: z.string().date().optional(),
    recovery_date: z.string().datetime().optional(),
    warehouse: z.string().trim().max(160).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    city: z.string().trim().max(120).optional(),
    state: z.string().trim().max(120).optional(),
    loan_sanction_id: z.string().uuid().optional(),
    recovery_pipeline_id: z.string().uuid().optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    const url = new URL(req.url);
    const parsed = Query.safeParse({
      state: url.searchParams.get("state") ?? undefined,
      warehouse: url.searchParams.get("warehouse") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
      page: url.searchParams.get("page") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    // The tallies are tenant-wide and filter-independent, so they ride along
    // with every list response rather than costing the register a second
    // round trip on each keystroke.
    const [result, counts] = await Promise.all([
      listBatteries({
        tenant_id: actor.tenant_id,
        state_code: parsed.data.state,
        warehouse: parsed.data.warehouse,
        q: parsed.data.q,
        page: parsed.data.page,
      }),
      batteryCounts(actor.tenant_id),
    ]);

    return NextResponse.json({ ok: true, ...result, counts });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);

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
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const result = await createRecoveryBattery({
      tenant_id: actor.tenant_id,
      ...parsed.data,
    });

    // 200 rather than 201 on a re-intake: nothing was created. The same
    // battery coming back through recovery a second time is a normal event,
    // and `reused` tells the caller which happened.
    return NextResponse.json(
      { ok: true, battery: result.battery, reused: result.reused },
      { status: result.reused ? 200 : 201 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(msg) },
      { status: statusFromError(msg) },
    );
  }
}
