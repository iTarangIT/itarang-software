/**
 * E-258 — one scrap consignment, from the NBFC's side.
 *
 *   GET    — the deal, its batteries and the full negotiation
 *   PATCH  — edit the draft (and, after submission, the payee bank details only)
 *   POST   — the moves: submit | counter | accept | reject | withdraw
 *
 * POST carries an `action` rather than being split across five routes: they are
 * one decision made in one place, and five files would mean five copies of the
 * same ownership check for no gain.
 *
 * NOTIFICATIONS FIRE HERE, NOT IN THE SERVICE. The service is the write path
 * and is also called by scripts; the notification is a consequence of a HUMAN
 * making the move. Every emit is awaited but can never throw (emit() swallows
 * its own failures), so the response is never held up by a mail server.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientError, validationError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import {
  getConsignment,
  respondToConsignment,
  submitConsignment,
  updateDraft,
} from "@/lib/nbfc/scrap/consignment";
import {
  notifyScrapAgreed,
  notifyScrapClosed,
  notifyScrapCountered,
  notifyScrapSubmitted,
} from "@/lib/nbfc/scrap/notify";

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

const PatchBody = z
  .object({
    // [E-260] The price fields are validated independently; which of them is
    // real is decided by the mode inside updateDraft(), not here.
    pricing_mode: z.enum(["flat", "itemised"]).optional(),
    asking_rate_per_battery: z.number().positive().max(10_000_000).nullable().optional(),
    item_rates: z
      .record(z.string().uuid(), z.number().positive().max(10_000_000))
      .optional(),
    note: z.string().max(2000).nullable().optional(),
    pickup_city: z.string().max(120).nullable().optional(),
    pickup_state: z.string().max(120).nullable().optional(),
    warehouse: z.string().max(160).nullable().optional(),
    payee_name: z.string().max(160).nullable().optional(),
    payee_account_number: z.string().max(40).nullable().optional(),
    payee_ifsc: z
      .string()
      .regex(/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/, "not a valid IFSC")
      .nullable()
      .optional(),
  })
  .strict();

const ActionBody = z
  .object({
    action: z.enum(["submit", "counter", "accept", "reject", "withdraw"]),
    rate_per_battery: z.number().positive().max(10_000_000).optional(),
    // [E-261] item_id → rate: a counter that answers battery by battery
    // instead of with one number. Allowed on ANY lot, whichever way the NBFC
    // first priced it — that is the flexibility. Wins over `amount`.
    item_rates: z
      .record(z.string().uuid(), z.number().positive().max(10_000_000))
      .optional(),
    // [E-260] An itemised lot is countered with a total, not a rate.
    amount: z.number().positive().max(1_000_000_000).optional(),
    message: z.string().max(2000).optional(),
  })
  .strict();

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await resolveActor(req.headers);
    const { id } = await ctx.params;
    const consignment = await getConsignment(id, actor.tenant_id);
    if (!consignment) {
      return NextResponse.json(
        { ok: false, error: "NOT_FOUND: consignment not found" },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, consignment });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(e) },
      { status: statusFromError(msg) },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await resolveActor(req.headers);
    const { id } = await ctx.params;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }
    const parsed = PatchBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: validationError(parsed.error), issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const consignment = await updateDraft(id, actor.tenant_id, parsed.data);
    return NextResponse.json({ ok: true, consignment });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(e) },
      { status: statusFromError(msg) },
    );
  }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await resolveActor(req.headers);
    const { id } = await ctx.params;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }
    const parsed = ActionBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: validationError(parsed.error), issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const { action, rate_per_battery, amount, item_rates, message } = parsed.data;

    if (action === "submit") {
      const consignment = await submitConsignment({
        id,
        tenant_id: actor.tenant_id,
        actor_user_id: actor.user_id ?? null,
        asking_rate_per_battery: rate_per_battery ?? null,
        message: message ?? null,
      });
      await notifyScrapSubmitted(consignment);
      return NextResponse.json({ ok: true, consignment });
    }

    const consignment = await respondToConsignment({
      id,
      party: "nbfc",
      tenant_id: actor.tenant_id,
      actor_user_id: actor.user_id ?? null,
      kind: action,
      rate_per_battery: rate_per_battery ?? null,
      amount: amount ?? null,
      item_rates: item_rates ?? null,
      message: message ?? null,
    });

    if (action === "counter") {
      await notifyScrapCountered(consignment, "nbfc", rate_per_battery ?? null, amount ?? null);
    } else if (action === "accept") {
      await notifyScrapAgreed(consignment, "nbfc");
    } else {
      // reject | withdraw — from this side both mean "we are not selling it to
      // you on these terms", and the copy distinguishes them.
      await notifyScrapClosed(
        consignment,
        action === "reject" ? "reject" : "withdraw",
        message ?? null,
        "nbfc",
      );
    }

    return NextResponse.json({ ok: true, consignment });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: clientError(e) },
      { status: statusFromError(msg) },
    );
  }
}
