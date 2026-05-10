/**
 * E-033 — POST /api/nbfc/actions/immobilisation/remobilise
 *
 * BRD §6.1.6 reversibility: an approved immobilisation can be reversed once
 * the borrower has settled. Caller provides a settlement_reference (e.g.
 * receipt id) and the action transitions to status='reversed'. Audit-logged.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { remobiliseImmobilisation } from "@/lib/nbfc/actions/request-immobilisation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  action_id: z.string().uuid(),
  settlement_reference: z.string().min(3),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
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
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const result = await remobiliseImmobilisation({
      tenant_id: actor.tenant_id,
      actor_user_id: actor.user_id,
      action_id: parsed.data.action_id,
      settlement_reference: parsed.data.settlement_reference,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
