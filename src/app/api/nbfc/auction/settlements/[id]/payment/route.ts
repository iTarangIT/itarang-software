/**
 * POST   /api/nbfc/auction/settlements/[id]/payment — record an offline payment
 * DELETE /api/nbfc/auction/settlements/[id]/payment — abandon an unpaid one
 *
 * The seller's two answers to "the gateway was not used".
 *
 * Most of these sales settle by bank transfer agreed on a phone call. Making
 * the gateway the only way past the `paid_at` gate would either block those
 * sales or force the gate to be left open — so the bypass is explicit,
 * attributed, reference-carrying and audited, and it stamps the same `paid_at`
 * a gateway capture would.
 *
 * DELETE is the other end: a winner who never pays used to freeze the
 * batteries for ever, because the lot was closed, the settlement never
 * completed, and nothing could re-list them.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import {
  recordOfflinePayment,
  abandonSettlement,
} from "@/lib/nbfc/auction/purchases";

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

const OfflineBody = z
  .object({
    reference: z.string().trim().min(1).max(120),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

const AbandonBody = z
  .object({ reason: z.string().trim().min(1).max(500) })
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
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }

    const parsed = OfflineBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const result = await recordOfflinePayment({
      actor_tenant_id: actor.tenant_id,
      actor_user_id: actor.user_id,
      settlement_id: id,
      reference: parsed.data.reference,
      note: parsed.data.note ?? null,
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

export async function DELETE(
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
        { ok: false, error: "BAD_REQUEST: a reason is required" },
        { status: 400 },
      );
    }

    const parsed = AbandonBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const result = await abandonSettlement({
      actor_tenant_id: actor.tenant_id,
      actor_user_id: actor.user_id,
      settlement_id: id,
      reason: parsed.data.reason,
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
