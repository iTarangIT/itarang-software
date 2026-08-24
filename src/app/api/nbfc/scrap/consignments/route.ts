/**
 * E-258 — GET/POST /api/nbfc/scrap/consignments
 *
 * The NBFC's own scrap consignments: list them, or bundle scrap batteries into
 * a new one. Everything is tenant-scoped inside the service; this route only
 * resolves who is asking.
 *
 * AuthN/Z: resolveActor() — the canonical NBFC path, identical to every other
 * /api/nbfc route. Any seat of the tenant may build and price a consignment;
 * selling scrap the NBFC already owns is not a dual-approval decision, and
 * gating it to nbfc_admin would leave the recovery operator who is holding the
 * batteries unable to move them.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientError, validationError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import {
  createConsignment,
  listConsignments,
  CONSIGNMENT_STATUSES,
} from "@/lib/nbfc/scrap/consignment";

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

const CreateBody = z
  .object({
    battery_ids: z.array(z.string().uuid()).min(1).max(500),
    // [E-260] 'flat' = one rate for the lot, 'itemised' = a rate per battery.
    // Absent means flat, which is what every caller sent before this existed.
    pricing_mode: z.enum(["flat", "itemised"]).optional(),
    asking_rate_per_battery: z.number().positive().max(10_000_000).optional(),
    item_rates: z
      .record(z.string().uuid(), z.number().positive().max(10_000_000))
      .optional(),
    note: z.string().max(2000).optional(),
    pickup_city: z.string().max(120).optional(),
    pickup_state: z.string().max(120).optional(),
    warehouse: z.string().max(160).optional(),
    payee_name: z.string().max(160).optional(),
    payee_account_number: z.string().max(40).optional(),
    // IFSC is exactly 11 characters: 4 letters, a 0, then 6 alphanumerics.
    // Checked here rather than at payout time because a wrong one discovered
    // then means a failed transfer and a support ticket.
    payee_ifsc: z
      .string()
      .regex(/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/, "not a valid IFSC")
      .optional(),
  })
  .strict();

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    const url = new URL(req.url);
    const statusParam = url.searchParams.get("status") ?? "all";
    const status = ([...CONSIGNMENT_STATUSES, "open", "all"] as string[]).includes(
      statusParam,
    )
      ? (statusParam as Parameters<typeof listConsignments>[0]["status"])
      : "all";

    const result = await listConsignments({
      tenant_id: actor.tenant_id,
      status,
      page: Number(url.searchParams.get("page") ?? 1) || 1,
      page_size: Math.min(
        Number(url.searchParams.get("page_size") ?? 50) || 50,
        100,
      ),
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(e) },
      { status: statusFromError(msg) },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }
    const parsed = CreateBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: validationError(parsed.error), issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const consignment = await createConsignment({
      tenant_id: actor.tenant_id,
      actor_user_id: actor.user_id ?? null,
      battery_ids: parsed.data.battery_ids,
      pricing_mode: parsed.data.pricing_mode ?? "flat",
      asking_rate_per_battery: parsed.data.asking_rate_per_battery ?? null,
      item_rates: parsed.data.item_rates ?? null,
      note: parsed.data.note ?? null,
      pickup_city: parsed.data.pickup_city ?? null,
      pickup_state: parsed.data.pickup_state ?? null,
      warehouse: parsed.data.warehouse ?? null,
      payee_name: parsed.data.payee_name ?? null,
      payee_account_number: parsed.data.payee_account_number ?? null,
      payee_ifsc: parsed.data.payee_ifsc ?? null,
    });

    return NextResponse.json({ ok: true, consignment }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(e) },
      { status: statusFromError(msg) },
    );
  }
}
