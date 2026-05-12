/**
 * E-090 — POST /api/nbfc/dpdpa/consent/withdraw
 *
 * Customer-initiated DPDPA consent withdrawal. The borrower contacts the
 * grievance channel (or helpline / email); a tenant operator records the
 * withdrawal here. The consent_records row is preserved (DPDPA does not
 * permit retroactive erasure) and the telemetry-derived scopes
 * (risk_assessment, warranty_management) are flipped to is_active=false.
 * Future risk-scoring jobs read the withdrawals table and exclude
 * telemetry-derived signals for this lead.
 *
 * Status codes:
 *   200 — withdrawal recorded
 *   400 — invalid body / unknown channel
 *   401 — caller has no NBFC tenant context
 *   403 — caller lacks NBFC access
 *   404 — no consent record for lead
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import {
  WITHDRAWAL_CHANNELS,
  withdrawConsent,
} from "@/lib/nbfc/dpdpa/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  lead_id: z.string().min(1),
  withdrawal_channel: z.enum(WITHDRAWAL_CHANNELS),
  reason: z.string().max(500).optional(),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
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

    const result = await withdrawConsent({
      lead_id: parsed.data.lead_id,
      withdrawal_channel: parsed.data.withdrawal_channel,
      reason: parsed.data.reason,
      performed_by: actor.user_id,
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
