/**
 * E-031 — POST /api/nbfc/actions/payment-reminder
 *
 * BRD §6.1.6 row "Send Payment Reminder": single NBFC-User approval, no
 * approval-gate (auto_approved), reversible=N/A, audit-logged automatically.
 *
 * AuthN/Z: resolveActor() — production uses the canonical Supabase session +
 * nbfc_users role; non-production accepts the triple-guarded test bypass
 * (NODE_ENV != production AND server NBFC_TEST_BYPASS_SECRET AND request
 * x-nbfc-test-bypass header).
 *
 * Per BRD §6.1.6 the action is open to any authenticated NBFC user (not gated
 * on the `risk_head` role) — it is the lowest-impact action in the framework.
 * Cross-tenant isolation is enforced inside sendPaymentReminder().
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { sendPaymentReminder } from "@/lib/nbfc/actions/payment-reminder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  loan_sanction_id: z.string().min(1),
  channel: z.enum(["sms", "whatsapp", "email"]).default("sms"),
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

    const result = await sendPaymentReminder({
      tenant_id: actor.tenant_id,
      loan_sanction_id: parsed.data.loan_sanction_id,
      channel: parsed.data.channel,
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
