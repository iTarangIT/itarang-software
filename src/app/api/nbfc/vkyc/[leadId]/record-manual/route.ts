/**
 * POST /api/nbfc/vkyc/[leadId]/record-manual
 *
 * §10 Own-VKYC (Q1a) fallback — record the NBFC's own session outcome when the
 * callback isn't wired. Role: operations | nbfc_admin. iTarang-mode tracks
 * resolve automatically via Decentro, so manual entry is for Own mode.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { videoKycVerifications } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment, getVkycTrack } from "@/lib/nbfc/vkyc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  status: z.enum(["verified", "failed", "in_progress"]),
  failure_reason: z.string().max(2000).nullable().optional(),
  match_score: z.union([z.number(), z.string()]).nullable().optional(),
  provider_name: z.string().max(80).nullable().optional(),
  provider_raw_status: z.string().max(120).nullable().optional(),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
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
    if (actor.role !== "operations" && actor.role !== "nbfc_admin") {
      return NextResponse.json({ ok: false, error: `FORBIDDEN: role '${actor.role}' cannot record VKYC` }, { status: 403 });
    }

    const assignment = await getActiveAssignment(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: no assignment for this tenant" }, { status: 400 });
    }
    const track = await getVkycTrack(leadId, assignment.nbfc_id);
    if (!track) {
      return NextResponse.json({ ok: false, error: "NOT_FOUND: no VKYC track (initiate first)" }, { status: 404 });
    }

    const d = parsed.data;
    const now = new Date();
    await db
      .update(videoKycVerifications)
      .set({
        status: d.status,
        match_score: d.match_score == null ? track.match_score : String(d.match_score),
        provider_name: d.provider_name ?? track.provider_name,
        provider_raw_status: d.provider_raw_status ?? track.provider_raw_status,
        failure_reason: d.failure_reason ?? (d.status === "failed" ? "Recorded failed (manual)" : track.failure_reason),
        completed_at: d.status === "verified" || d.status === "failed" ? now : track.completed_at,
        updated_at: now,
      })
      .where(eq(videoKycVerifications.id, track.id));

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
