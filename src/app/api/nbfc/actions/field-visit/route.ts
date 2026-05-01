/**
 * E-032 — POST /api/nbfc/actions/field-visit
 *
 * BRD §6.1.6 row "Request Field Visit": single approval (NBFC Manager),
 * reversible, manual reason mandatory, audit-logged.
 *
 * AuthN/Z: resolveActor() — production uses the canonical Supabase session +
 * nbfc_users role; non-production accepts the triple-guarded test bypass.
 *
 * Caller must hold the `nbfc_manager` role (or higher: admin / ceo). The
 * `nbfc_credit_manager` role is also accepted because it is the canonical
 * Manager-tier role used in the dual-approval map.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { requestFieldVisit } from "@/lib/nbfc/actions/field-visit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  loan_sanction_id: z.string().min(1),
  reason: z.string().min(10),
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
    // Parse + validate the body BEFORE the role gate so AC2 (zod validation)
    // is not pre-empted by the 403 from AC3 when both could trip.
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

    const result = await requestFieldVisit({
      tenant_id: actor.tenant_id,
      loan_sanction_id: parsed.data.loan_sanction_id,
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
