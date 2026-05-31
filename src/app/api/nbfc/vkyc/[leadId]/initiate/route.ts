/**
 * POST /api/nbfc/vkyc/[leadId]/initiate
 *
 * BRD Addendum V0.2 §10 — start a Video KYC session for the acting NBFC.
 *   mode 'own'     → B2-B: mark the track in_progress and hand the vkyc_ref +
 *                    callback URL to the NBFC; the NBFC runs its own vendor and
 *                    posts the canonical result back. No iTarang per-run cost.
 *   mode 'itarang' → iTarang's Decentro Active Liveness: initiate a hosted
 *                    session, record an attempt row (the per-run billing unit,
 *                    §8.2), return the session URL.
 *
 * Role: `operations` (owns VKYC initiation, §7.2) or `nbfc_admin`.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcServiceConfig, videoKycAttempts, videoKycVerifications } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { generateVkycRef, getActiveAssignment } from "@/lib/nbfc/vkyc";
import { assertNotHaltedByFailure } from "@/lib/nbfc/track-gate";
import { activeVideoLivenessInitiate } from "@/lib/decentro";
import { getCustomerFaceImagesForLead } from "@/lib/kyc/active-vkyc-images";
import { publicOrigin, PublicOriginError } from "@/lib/public-origin";
import { assertChargeable, postCharge } from "@/lib/nbfc/charging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  if (msg.startsWith("INSUFFICIENT_FUNDS")) return 402;
  return 500;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    const actor = await resolveActor(req.headers);
    if (actor.role !== "operations" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role '${actor.role}' cannot initiate VKYC; operations or nbfc_admin required` },
        { status: 403 },
      );
    }

    const assignment = await getActiveAssignment(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: no assignment for this lead under this tenant" }, { status: 400 });
    }

    // Mode: per-lead snapshot first (§7.4), fall back to live config.
    let mode = assignment.snapshot.vkyc_mode ?? null;
    let enabled = assignment.snapshot.vkyc_enabled ?? false;
    if (!assignment.snapshot.vkyc_mode) {
      const cfg = await db
        .select({ enabled: nbfcServiceConfig.vkyc_enabled, mode: nbfcServiceConfig.vkyc_mode })
        .from(nbfcServiceConfig)
        .where(eq(nbfcServiceConfig.tenant_id, actor.tenant_id))
        .limit(1);
      enabled = cfg[0]?.enabled ?? false;
      mode = (cfg[0]?.mode as "own" | "itarang" | null) ?? null;
    }
    if (!enabled || !mode) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: Video KYC is not opted in for this lead's NBFC" }, { status: 400 });
    }

    // §7.4 Track Rules — if a sibling track has failed and this NBFC halts the
    // others on failure, a new VKYC run must not start.
    await assertNotHaltedByFailure(leadId, "vkyc");

    // §8.1 — an empty wallet blocks initiation of new chargeable activity. The
    // iTarang VKYC flat fee applies per run (§8.2); Own VKYC has no iTarang cost.
    if (mode === "itarang") {
      await assertChargeable(actor.tenant_id, "on_vkyc_run");
    }

    const now = new Date();
    const vkycRef = generateVkycRef(leadId);

    // Ensure a single track row per (lead, nbfc). Re-initiating resets it to
    // in_progress; a previously verified track is left alone.
    const [track] = await db
      .insert(videoKycVerifications)
      .values({
        lead_id: leadId,
        nbfc_id: assignment.nbfc_id,
        tenant_id: actor.tenant_id,
        vkyc_ref: vkycRef,
        mode,
        status: "in_progress",
        provider_name: mode === "itarang" ? "decentro_active_liveness" : null,
        triggered_by: actor.user_id,
        triggered_at: now,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: [videoKycVerifications.lead_id, videoKycVerifications.nbfc_id],
        set: { status: "in_progress", mode, triggered_by: actor.user_id, triggered_at: now, updated_at: now },
      })
      .returning({ id: videoKycVerifications.id, status: videoKycVerifications.status });

    if (mode === "own") {
      let origin = "";
      try {
        origin = publicOrigin({ req });
      } catch {
        origin = "";
      }
      return NextResponse.json({
        ok: true,
        mode,
        track_id: track.id,
        vkyc_ref: vkycRef,
        callback_url: origin ? `${origin}/api/nbfc/vkyc/callback` : "/api/nbfc/vkyc/callback",
      });
    }

    // iTarang Decentro Active Liveness.
    let origin: string;
    try {
      origin = publicOrigin({ req });
    } catch (err) {
      const msg = err instanceof PublicOriginError ? err.message : "Cannot determine public origin";
      return NextResponse.json({ ok: false, error: `Server misconfig: ${msg}` }, { status: 500 });
    }

    const images = await getCustomerFaceImagesForLead(leadId);
    if (images.urls.length + images.base64s.length === 0) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: no face images available for Decentro matching", missing: images.missing },
        { status: 400 },
      );
    }

    const decentro = await activeVideoLivenessInitiate({
      reference_id: vkycRef,
      redirect_url: `${origin}/api/kyc/decentro/active-video-liveness/return`,
      callback_url: `${origin}/api/nbfc/vkyc/callback`,
      face_image_urls: images.urls,
      face_image_base64s: images.base64s,
      consent_purpose: "Customer identity verification for loan (NBFC origination)",
    });

    if (!decentro.decentroTxnId || !decentro.videoLivenessUrl) {
      await db
        .update(videoKycVerifications)
        .set({ status: "failed", failure_reason: decentro.message ?? "Decentro initiate failed", updated_at: new Date() })
        .where(eq(videoKycVerifications.id, track.id));
      return NextResponse.json({ ok: false, error: `Decentro initiate failed: ${decentro.message ?? "unknown"}` }, { status: 502 });
    }

    const [attempt] = await db
      .insert(videoKycAttempts)
      .values({
        verification_id: track.id,
        lead_id: leadId,
        nbfc_id: assignment.nbfc_id,
        tenant_id: actor.tenant_id,
        attempt_ref: vkycRef,
        provider_txn_id: decentro.decentroTxnId,
        session_url: decentro.videoLivenessUrl,
        status: "in_progress",
        provider_raw_status: decentro.status ?? decentro.responseStatus ?? null,
        provider_raw_payload: decentro as unknown as Record<string, unknown>,
        updated_at: now,
      })
      .returning({ id: videoKycAttempts.id });

    // §8.2 — post the iTarang-VKYC flat-fee charge for this run (charged on
    // every run, including losing/failed leads). Best-effort: the session is
    // already live, so a ledger hiccup must not fail the request.
    try {
      const ledgerIds = await postCharge({
        tenantId: actor.tenant_id,
        trigger: "on_vkyc_run",
        leadId,
        nbfcId: assignment.nbfc_id,
        postedBy: actor.user_id,
        descriptionSuffix: `VKYC run · lead ${leadId}`,
      });
      if (ledgerIds.length > 0) {
        await db
          .update(videoKycAttempts)
          .set({ charged: true, charged_ledger_id: ledgerIds[0], updated_at: new Date() })
          .where(eq(videoKycAttempts.id, attempt.id));
      }
    } catch (chargeErr) {
      console.error("[NBFC VKYC] charge posting failed:", chargeErr);
    }

    return NextResponse.json({
      ok: true,
      mode,
      track_id: track.id,
      attempt_id: attempt.id,
      session_url: decentro.videoLivenessUrl,
      provider_txn_id: decentro.decentroTxnId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
