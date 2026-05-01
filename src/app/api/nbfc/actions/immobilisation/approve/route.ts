/**
 * E-033 — POST /api/nbfc/actions/immobilisation/approve
 *
 * BRD §6.1.6 dual-approval second step: an Ops Head flips a pending
 * Risk-Head-submitted immobilisation request to status='approved'.
 * Audit-logged.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { approveImmobilisation } from "@/lib/nbfc/actions/request-immobilisation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  action_id: z.string().uuid(),
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

    const result = await approveImmobilisation({
      tenant_id: actor.tenant_id,
      actor_user_id: actor.user_id,
      actor_role: actor.role,
      action_id: parsed.data.action_id,
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
