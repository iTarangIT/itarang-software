/**
 * POST /api/nbfc/enach/[leadId]/waive
 *
 * BRD Addendum V0.2 §9.2 — "Mark E-NACH Not Required". A Credit/Underwriting
 * officer may waive E-NACH for a SPECIFIC lead with a reason; the track closes
 * as `skipped` and the disbursal gate no longer applies to that lead. The
 * waiver is restricted to the Credit officer and is E-NACH-only (FI and Video
 * KYC have no per-lead skip).
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";

import { db } from "@/lib/db";
import { enachMandates } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { generateEnachRef, getWinningAssignment } from "@/lib/nbfc/enach";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ reason: z.string().trim().min(3).max(1000) });

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "VALIDATION", issues: parsed.error.issues }, { status: 400 });
    }

    const actor = await resolveActor(req.headers);
    // §9.2 — waiver is restricted to Credit/Underwriting (nbfc_admin may also act
    // since it holds full configuration authority).
    if (actor.role !== "credit_underwriting" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: only Credit/Underwriting may waive E-NACH (role '${actor.role}')` },
        { status: 403 },
      );
    }

    const winner = await getWinningAssignment(leadId);
    if (!winner || winner.tenant_id !== actor.tenant_id) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: no winning NBFC for this lead under this tenant" },
        { status: 400 },
      );
    }

    const now = new Date();
    const [created] = await db
      .insert(enachMandates)
      .values({
        lead_id: leadId,
        nbfc_id: winner.nbfc_id,
        tenant_id: actor.tenant_id,
        enach_ref: generateEnachRef(leadId),
        status: "skipped",
        skip_reason: parsed.data.reason,
        skipped_by: actor.user_id,
        skipped_at: now,
        updated_at: now,
      })
      .returning({ id: enachMandates.id });

    return NextResponse.json({ ok: true, mandate_id: created.id, status: "skipped" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
