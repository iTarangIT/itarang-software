/**
 * GET /api/nbfc/fi/[leadId] — BRD Addendum V0.3.1 §10.
 *
 * Returns the acting NBFC's CURRENT Field Investigation attempt for the lead,
 * plus everything the Acquire FI panel + Review screen need:
 *   - track (with derived sla_breached), photos, auto-flags (§10.8.1)
 *   - the assigned agent + the active-agent directory for the picker
 *   - attempt history summary (§10.10), opt-in state, and FI config (§10.7)
 *   - can_act (only fi_coordinator / nbfc_admin decide; others are read-only)
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcServiceConfig } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { resolveServiceOptIn } from "@/lib/nbfc/service-opt-in";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { computeFiAutoFlags, getCurrentFiTrack, getFiHistory, getFiPhotos } from "@/lib/nbfc/fi";
import { getFiAgent, listFiAgents } from "@/lib/nbfc/fi-agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  return 500;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    const actor = await resolveActor(req.headers);
    const assignment = await getActiveAssignment(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json({ ok: true, track: null, reason: "No assignment for this tenant." });
    }

    // Fetch the independent pieces concurrently — track, opt-in/config, prior
    // attempts and the agent directory don't depend on one another.
    const [track, cfg, historyRows, agents] = await Promise.all([
      getCurrentFiTrack(leadId, assignment.nbfc_id),
      db
        .select({ fi: nbfcServiceConfig.fi_enabled, fiConfig: nbfcServiceConfig.fi_config })
        .from(nbfcServiceConfig)
        .where(eq(nbfcServiceConfig.tenant_id, actor.tenant_id))
        .limit(1),
      getFiHistory(leadId, assignment.nbfc_id),
      listFiAgents(actor.tenant_id, { activeOnly: true }),
    ]);

    const overdue =
      !!track &&
      !!track.sla_due_at &&
      (track.status === "assigned" || track.status === "in_progress") &&
      new Date(track.sla_due_at).getTime() < Date.now();

    // Opt-in is read LIVE (resolveServiceOptIn) — switching FI off in Settings
    // takes the track out of in-flight leads too. The FI form parameters below
    // stay live as well, matching the action route's checks.
    const enabled = (
      await resolveServiceOptIn(actor.tenant_id, assignment.snapshot)
    ).fi_enabled;
    const fiConfig = (cfg[0]?.fiConfig as Record<string, unknown> | undefined) ?? null;

    // Decision context for a submitted/decided attempt — photos + agent in
    // parallel; both only exist when there's a current attempt.
    let photos: Awaited<ReturnType<typeof getFiPhotos>> = [];
    let agent = null;
    let autoFlags: ReturnType<typeof computeFiAutoFlags> = [];
    if (track) {
      [photos, agent] = await Promise.all([
        getFiPhotos(track.id),
        track.assigned_agent_id
          ? getFiAgent(track.assigned_agent_id, actor.tenant_id)
          : Promise.resolve(null),
      ]);
      autoFlags = computeFiAutoFlags(
        { ...track, sla_breached: track.sla_breached || overdue },
        photos,
        !!agent?.reference_photo_url,
      );
    }

    // Lightweight history (prior attempts).
    const history = historyRows
      .filter((h) => !h.is_current)
      .map((h) => ({
        id: h.id,
        attempt_no: h.attempt_no,
        status: h.status,
        decision: h.decision,
        decision_reason: h.decision_reason,
        assigned_to: h.assigned_to,
        decided_at: h.decided_at,
      }));

    return NextResponse.json({
      ok: true,
      track: track ? { ...track, sla_breached: track.sla_breached || overdue } : null,
      photos,
      agent,
      auto_flags: autoFlags,
      history,
      agents,
      fi_config: fiConfig,
      can_act: actor.role === "fi_coordinator" || actor.role === "nbfc_admin",
      can_reopen: actor.role === "nbfc_admin",
      role: actor.role,
      enabled,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
