/**
 * E-032 — POST /api/nbfc/actions/field-visit/cancel
 *
 * BRD §6.1.6 row "Request Field Visit" is reversible — the cancel endpoint
 * flips an existing field_visit action's status to 'reversed' and writes an
 * additional immutable nbfc_audit_log row capturing the cancellation reason.
 *
 * Same role gate as the initiate endpoint: caller must be NBFC Manager (or
 * higher).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { cancelFieldVisit } from "@/lib/nbfc/actions/field-visit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  action_id: z.string().min(1),
  reason: z.string().min(5),
});

const MANAGER_ROLES = new Set([
  "nbfc_manager",
  "nbfc_credit_manager",
  "admin",
  "ceo",
]);

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

    const actor = await resolveActor(req.headers);

    if (!MANAGER_ROLES.has(actor.role)) {
      return NextResponse.json(
        {
          ok: false,
          error: `FORBIDDEN: caller role '${actor.role}' is not authorised; nbfc_manager required`,
        },
        { status: 403 },
      );
    }

    const result = await cancelFieldVisit({
      tenant_id: actor.tenant_id,
      action_id: parsed.data.action_id,
      reason: parsed.data.reason,
      actor_user_id: actor.user_id,
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
