/**
 * GET /api/nbfc/vkyc/[leadId]
 *
 * Returns the acting NBFC's Video KYC track for the lead. For the iTarang
 * (Decentro) mode it lazily fetches + decodes the result once the customer's
 * session callback has landed (mirrors the Step-2 active-liveness /status
 * route), persisting liveliness / risk flags / best face-match score and
 * flipping the track to verified|failed. Own-mode tracks are resolved by the
 * NBFC callback, so this just echoes state.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcServiceConfig, videoKycAttempts, videoKycVerifications } from "@/lib/db/schema";
import { activeVideoLivenessResult } from "@/lib/decentro";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { getActiveAssignment, getVkycAttempts, getVkycTrack } from "@/lib/nbfc/vkyc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function pickBestMatchScore(results: unknown): number | null {
  const arr = (results as { videoFaceMatchResults?: Array<{ results?: { matchScore?: number } }> } | null)?.videoFaceMatchResults;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  let best = -1;
  for (const r of arr) {
    const s = r?.results?.matchScore;
    if (typeof s === "number" && s > best) best = s;
  }
  return best >= 0 ? best : null;
}
function isTrueish(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase() === "true";
  return false;
}
function buildFailedReason(d: { liveliness?: unknown; staticRisk?: unknown; prerecordedRisk?: unknown } | undefined): string | null {
  if (!d) return null;
  const reasons: string[] = [];
  const live = (d.liveliness ?? "").toString().toLowerCase();
  if (live && live !== "yes") reasons.push(`liveliness=${live}`);
  if (isTrueish(d.staticRisk)) reasons.push("staticRisk");
  if (isTrueish(d.prerecordedRisk)) reasons.push("prerecordedRisk");
  return reasons.length > 0 ? `Decentro flagged: ${reasons.join(", ")}` : null;
}

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

    // Opt-in state (mirrors the initiate route): per-lead snapshot first, live
    // config fallback when the snapshot carries no mode (§7.4). Lets the UI show
    // a clear "not opted in" notice rather than a button that 400s on click.
    let enabled = assignment.snapshot.vkyc_enabled ?? false;
    if (!assignment.snapshot.vkyc_mode) {
      const cfg = await db
        .select({ enabled: nbfcServiceConfig.vkyc_enabled, mode: nbfcServiceConfig.vkyc_mode })
        .from(nbfcServiceConfig)
        .where(eq(nbfcServiceConfig.tenant_id, actor.tenant_id))
        .limit(1);
      enabled = cfg[0]?.enabled ?? false;
    }
    const canAct = actor.role === "operations" || actor.role === "nbfc_admin";

    let track = await getVkycTrack(leadId, assignment.nbfc_id);
    if (!track) {
      return NextResponse.json({ ok: true, track: null, can_act: canAct, enabled });
    }

    // Lazy Decentro result fetch (iTarang mode): callback landed, not yet decoded.
    if (track.mode === "itarang" && track.status === "in_progress") {
      const [attempt] = await db
        .select()
        .from(videoKycAttempts)
        .where(eq(videoKycAttempts.verification_id, track.id))
        .orderBy(desc(videoKycAttempts.updated_at))
        .limit(1);
      const ap = (attempt?.provider_raw_payload ?? {}) as Record<string, unknown>;
      const callbackReceived = !!ap.callback_received_at;
      const alreadyDecoded = !!ap.results_fetched_at;
      if (attempt && attempt.provider_txn_id && attempt.attempt_ref && callbackReceived && !alreadyDecoded) {
        const res = await activeVideoLivenessResult(attempt.provider_txn_id, attempt.attempt_ref);
        const ok = res.status === "SUCCESS" || res.responseStatus === "SUCCESS";
        const data = res.data as Record<string, unknown> | undefined;
        const bestScore = pickBestMatchScore(data);
        const failedReason = ok ? buildFailedReason(data) : res.message || "Decentro result fetch failed";
        const now = new Date();
        const verified = ok && !failedReason;
        await db
          .update(videoKycAttempts)
          .set({
            status: verified ? "verified" : "failed",
            provider_raw_payload: { ...ap, results: data ?? null, result_response: res, results_fetched_at: now.toISOString() },
            updated_at: now,
          })
          .where(eq(videoKycAttempts.id, attempt.id));
        await db
          .update(videoKycVerifications)
          .set({
            status: verified ? "verified" : "failed",
            match_score: bestScore !== null ? bestScore.toFixed(2) : null,
            face_match_score: bestScore !== null ? bestScore.toFixed(2) : null,
            liveliness: data?.liveliness ? String(data.liveliness).slice(0, 16) : null,
            static_risk: isTrueish(data?.staticRisk),
            prerecorded_risk: isTrueish(data?.prerecordedRisk),
            geo_location: (data?.geoLocation as Record<string, unknown> | undefined) ?? null,
            provider_raw_status: ok ? "SUCCESS" : "FAILURE",
            provider_raw_payload: data ?? null,
            failure_reason: failedReason,
            completed_at: now,
            updated_at: now,
          })
          .where(eq(videoKycVerifications.id, track.id));
        track = await getVkycTrack(leadId, assignment.nbfc_id);
      }
    }

    // History bar: every VKYC run for this track (oldest → newest).
    const history = track ? await getVkycAttempts(track.id) : [];

    return NextResponse.json({
      ok: true,
      track,
      history,
      can_act: canAct,
      enabled,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
