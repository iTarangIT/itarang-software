/**
 * E-090 — GET /api/nbfc/dpdpa/consent?lead_id=...
 *
 * Returns the DPDPA-shaped consent snapshot for a lead: which scopes are
 * currently active, when the original consent was signed, and whether the
 * lead has withdrawn (and through which channel).
 *
 * Status codes:
 *   200 — snapshot returned
 *   400 — missing/invalid lead_id
 *   401 — caller has no NBFC tenant context
 *   403 — caller lacks NBFC access
 *   404 — no consent record exists for lead
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getConsentSnapshot } from "@/lib/nbfc/dpdpa/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Query = z.object({ lead_id: z.string().min(1) });

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function GET(req: NextRequest) {
  try {
    await resolveActor(req.headers);
    const url = new URL(req.url);
    const parsed = Query.safeParse({ lead_id: url.searchParams.get("lead_id") });
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const snapshot = await getConsentSnapshot(parsed.data.lead_id);
    if (!snapshot) {
      return NextResponse.json(
        { ok: false, error: "NOT_FOUND: no consent record for lead" },
        { status: 404 },
      );
    }
    return NextResponse.json(snapshot, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
