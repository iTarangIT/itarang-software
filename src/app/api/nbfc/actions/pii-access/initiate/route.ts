/**
 * E-089 — POST /api/nbfc/actions/pii-access/initiate
 *
 * Requestor (authenticated + MFA) opens a dual-approval request for unmasked
 * Aadhaar/PAN view of a single lead. Approver-2 is iTarang Compliance Officer
 * (resolved by the dual-approval action_config / fallback). The grant itself
 * is minted lazily by /unmask once the approval lands.
 *
 * AuthN/Z: resolveActor (canonical NBFC route bypass-or-session pattern).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { initiatePiiAccess } from "@/lib/nbfc/pii-access/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  lead_id: z.string().min(1),
  fields: z.array(z.enum(["aadhaar", "pan"])).min(1),
  mfa_token: z.string().min(1),
  reason_code: z.string().min(1),
  reviewed_evidence_ack: z.literal(true),
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
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }
    const parsed = Body.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const result = await initiatePiiAccess({
      tenant_id: actor.tenant_id,
      initiator_user_id: actor.user_id,
      lead_id: parsed.data.lead_id,
      fields: parsed.data.fields,
      reason_code: parsed.data.reason_code,
      mfa_token: parsed.data.mfa_token,
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
