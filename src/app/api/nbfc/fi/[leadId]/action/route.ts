/**
 * POST /api/nbfc/fi/[leadId]/action
 *
 * BRD Addendum V0.2 §6.3 — drives the Field Investigation track:
 *   action 'assign'   → assign an agent; opens the 48h SLA window.
 *   action 'update'   → record the visit: GPS (~50 m supporting), text match, notes, proof.
 *   action 'complete' → record the outcome (pass → completed, fail → failed).
 *
 * Role: `fi_coordinator` (owns the FI step, §7.2) or `nbfc_admin`.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { fieldInvestigations, nbfcServiceConfig } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { getFiTrack, slaDueFrom } from "@/lib/nbfc/fi";
import { assertNotHaltedByFailure } from "@/lib/nbfc/track-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  action: z.enum(["assign", "update", "complete"]),
  assigned_to: z.string().max(200).optional(),
  visited_at: z.string().optional(),
  address_text_match: z.boolean().optional(),
  gps_lat: z.union([z.number(), z.string()]).optional(),
  gps_lng: z.union([z.number(), z.string()]).optional(),
  gps_accuracy_m: z.union([z.number(), z.string()]).optional(),
  agent_notes: z.string().max(4000).optional(),
  proof_urls: z.array(z.string().max(2048)).max(20).optional(),
  outcome: z.enum(["pass", "fail"]).optional(),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

const asNum = (v: number | string | undefined) => (v == null ? undefined : String(v));

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
    const d = parsed.data;

    const actor = await resolveActor(req.headers);
    if (actor.role !== "fi_coordinator" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role '${actor.role}' cannot act on FI; fi_coordinator or nbfc_admin required` },
        { status: 403 },
      );
    }

    const assignment = await getActiveAssignment(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: no assignment for this tenant" }, { status: 400 });
    }

    const now = new Date();

    if (d.action === "assign") {
      if (!d.assigned_to?.trim()) {
        return NextResponse.json({ ok: false, error: "BAD_REQUEST: assigned_to required" }, { status: 400 });
      }
      // FI must be opted in (per-lead snapshot first, §7.4).
      let enabled = (assignment.snapshot as { fi_enabled?: boolean }).fi_enabled ?? false;
      if (assignment.snapshot.fi_enabled === undefined) {
        const cfg = await db
          .select({ fi: nbfcServiceConfig.fi_enabled })
          .from(nbfcServiceConfig)
          .where(eq(nbfcServiceConfig.tenant_id, actor.tenant_id))
          .limit(1);
        enabled = cfg[0]?.fi ?? false;
      }
      if (!enabled) {
        return NextResponse.json({ ok: false, error: "BAD_REQUEST: Field Investigation is not opted in for this NBFC" }, { status: 400 });
      }

      // §7.4 Track Rules — if a sibling track failed and this NBFC halts the
      // others on failure, do not open a new FI. (Updating/completing an
      // already-assigned FI stays allowed below.)
      await assertNotHaltedByFailure(leadId, "fi");

      const values = {
        lead_id: leadId,
        nbfc_id: assignment.nbfc_id,
        tenant_id: actor.tenant_id,
        status: "assigned",
        assigned_to: d.assigned_to.trim(),
        assigned_by: actor.user_id,
        assigned_at: now,
        sla_due_at: slaDueFrom(now),
        sla_breached: false,
        updated_at: now,
      };
      await db
        .insert(fieldInvestigations)
        .values(values)
        .onConflictDoUpdate({
          target: [fieldInvestigations.lead_id, fieldInvestigations.nbfc_id],
          set: {
            status: "assigned",
            assigned_to: values.assigned_to,
            assigned_by: values.assigned_by,
            assigned_at: now,
            sla_due_at: values.sla_due_at,
            sla_breached: false,
            updated_at: now,
          },
        });
      return NextResponse.json({ ok: true, status: "assigned", sla_due_at: values.sla_due_at });
    }

    const track = await getFiTrack(leadId, assignment.nbfc_id);
    if (!track) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: assign an agent before updating" }, { status: 400 });
    }

    if (d.action === "update") {
      await db
        .update(fieldInvestigations)
        .set({
          status: track.status === "completed" || track.status === "failed" ? track.status : "in_progress",
          visited_at: d.visited_at ? new Date(d.visited_at) : track.visited_at,
          address_text_match: d.address_text_match ?? track.address_text_match,
          gps_lat: asNum(d.gps_lat) ?? track.gps_lat,
          gps_lng: asNum(d.gps_lng) ?? track.gps_lng,
          gps_accuracy_m: asNum(d.gps_accuracy_m) ?? track.gps_accuracy_m,
          agent_notes: d.agent_notes ?? track.agent_notes,
          proof_urls: d.proof_urls ?? track.proof_urls,
          updated_at: now,
        })
        .where(eq(fieldInvestigations.id, track.id));
      return NextResponse.json({ ok: true, status: "in_progress" });
    }

    // complete
    if (!d.outcome) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: outcome (pass|fail) required" }, { status: 400 });
    }
    await db
      .update(fieldInvestigations)
      .set({
        status: d.outcome === "pass" ? "completed" : "failed",
        outcome: d.outcome,
        agent_notes: d.agent_notes ?? track.agent_notes,
        proof_urls: d.proof_urls ?? track.proof_urls,
        reviewed_by: actor.user_id,
        reviewed_at: now,
        updated_at: now,
      })
      .where(eq(fieldInvestigations.id, track.id));
    return NextResponse.json({ ok: true, status: d.outcome === "pass" ? "completed" : "failed" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
