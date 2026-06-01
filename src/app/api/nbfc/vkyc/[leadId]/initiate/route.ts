/**
 * POST /api/nbfc/vkyc/[leadId]/initiate
 *
 * Addendum V0.3.1 §11 — PASSIVE Video KYC. Sends the customer a single-use
 * link (over SMS / Email / WhatsApp, operator's choice) to record a short LIVE
 * selfie video. The recorded video is later scored by Decentro's PASSIVE
 * liveness endpoint (/v2/kyc/forensics/video_liveness) when the customer
 * submits at /vkyc/<token>. This replaces the old Decentro ACTIVE (agent-style,
 * hosted-session) flow.
 *
 * The track's vkyc_ref doubles as the capture-link token (E-152). The link is
 * valid while status='in_progress' and not past link_expires_at.
 *
 * Role: `operations` (owns VKYC initiation, §7.2) or `nbfc_admin`.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads, nbfcServiceConfig, videoKycAttempts, videoKycVerifications } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { generateVkycRef, getActiveAssignment } from "@/lib/nbfc/vkyc";
import { assertNotHaltedByFailure } from "@/lib/nbfc/track-gate";
import { dispatchVkycLink, type VkycChannel } from "@/lib/nbfc/vkyc-dispatch";
import { publicOrigin, PublicOriginError } from "@/lib/public-origin";
import { assertChargeable, postCharge } from "@/lib/nbfc/charging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// How long the capture link stays valid.
const LINK_TTL_HOURS = 72;

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

    // Channel the operator picked to deliver the link.
    let channel: VkycChannel = "email";
    try {
      const body = (await req.json()) as { channel?: string } | null;
      const c = (body?.channel ?? "").toLowerCase();
      if (c === "email" || c === "sms" || c === "whatsapp") channel = c;
      else if (c) {
        return NextResponse.json({ ok: false, error: "BAD_REQUEST: channel must be email, sms or whatsapp" }, { status: 400 });
      }
    } catch {
      /* no/blank body — default to email */
    }

    const assignment = await getActiveAssignment(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: no assignment for this lead under this tenant" }, { status: 400 });
    }

    // Opt-in: per-lead snapshot first (§7.4), fall back to live config.
    let enabled = assignment.snapshot.vkyc_enabled ?? false;
    if (assignment.snapshot.vkyc_enabled === undefined) {
      const cfg = await db
        .select({ enabled: nbfcServiceConfig.vkyc_enabled })
        .from(nbfcServiceConfig)
        .where(eq(nbfcServiceConfig.tenant_id, actor.tenant_id))
        .limit(1);
      enabled = cfg[0]?.enabled ?? false;
    }
    if (!enabled) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: Video KYC is not opted in for this lead's NBFC" }, { status: 400 });
    }

    // §7.4 Track Rules — don't start a new run if a sibling track failed and
    // this NBFC halts the others on failure.
    await assertNotHaltedByFailure(leadId, "vkyc");

    // §8.1/§8.2 — passive VKYC is iTarang-operated (Decentro), so an empty
    // wallet blocks a new run; the flat fee applies per run.
    await assertChargeable(actor.tenant_id, "on_vkyc_run");

    // Public origin for the capture link (hard-fail rather than send a bad URL).
    let origin: string;
    try {
      origin = publicOrigin({ req });
    } catch (err) {
      const msg = err instanceof PublicOriginError ? err.message : "Cannot determine public origin";
      return NextResponse.json({ ok: false, error: `Server misconfig: ${msg}` }, { status: 500 });
    }

    // Customer contact for link delivery.
    const [lead] = await db
      .select({
        full_name: leads.full_name,
        owner_name: leads.owner_name,
        owner_email: leads.owner_email,
        phone: leads.phone,
        owner_contact: leads.owner_contact,
      })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!lead) {
      return NextResponse.json({ ok: false, error: "NOT_FOUND: lead not found" }, { status: 404 });
    }
    const customerName = lead.full_name ?? lead.owner_name ?? "Customer";
    const customerEmail = (lead.owner_email || "").trim() || null;
    const customerPhone = (lead.phone || lead.owner_contact || "").trim() || null;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + LINK_TTL_HOURS * 60 * 60 * 1000);
    const vkycRef = generateVkycRef(leadId);
    const linkUrl = `${origin}/vkyc/${vkycRef}`;

    // Dispatch BEFORE persisting in_progress so a delivery failure (e.g. SMS
    // disabled) doesn't leave a live link the customer never received.
    const sent = await dispatchVkycLink({
      channel,
      email: customerEmail,
      phone: customerPhone,
      url: linkUrl,
      customerName,
      expiresAt,
    });
    if (!sent.ok) {
      return NextResponse.json({ ok: false, error: sent.error ?? `Could not send the link via ${channel}` }, { status: 400 });
    }

    // Upsert the track → in_progress, passive mode, link metadata.
    const [track] = await db
      .insert(videoKycVerifications)
      .values({
        lead_id: leadId,
        nbfc_id: assignment.nbfc_id,
        tenant_id: actor.tenant_id,
        vkyc_ref: vkycRef,
        mode: "passive",
        status: "in_progress",
        provider_name: "decentro_passive_liveness",
        link_channel: channel,
        link_sent_at: now,
        link_expires_at: expiresAt,
        triggered_by: actor.user_id,
        triggered_at: now,
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: [videoKycVerifications.lead_id, videoKycVerifications.nbfc_id],
        set: {
          status: "in_progress",
          mode: "passive",
          provider_name: "decentro_passive_liveness",
          vkyc_ref: vkycRef,
          link_channel: channel,
          link_sent_at: now,
          link_expires_at: expiresAt,
          // clear any prior result so the re-sent link starts fresh
          match_score: null,
          liveliness: null,
          static_risk: null,
          prerecorded_risk: null,
          failure_reason: null,
          completed_at: null,
          admin_action: null,
          admin_action_by: null,
          admin_action_at: null,
          triggered_by: actor.user_id,
          triggered_at: now,
          updated_at: now,
        },
      })
      .returning({ id: videoKycVerifications.id });

    // §8.2 — one attempt row per run (the billing unit). session_url holds the
    // capture link. Charge best-effort: the link is already sent.
    const [attempt] = await db
      .insert(videoKycAttempts)
      .values({
        verification_id: track.id,
        lead_id: leadId,
        nbfc_id: assignment.nbfc_id,
        tenant_id: actor.tenant_id,
        attempt_ref: vkycRef,
        session_url: linkUrl,
        status: "in_progress",
        provider_raw_status: `link_sent_${sent.channel}`,
        updated_at: now,
      })
      .returning({ id: videoKycAttempts.id });

    try {
      const ledgerIds = await postCharge({
        tenantId: actor.tenant_id,
        trigger: "on_vkyc_run",
        leadId,
        nbfcId: assignment.nbfc_id,
        postedBy: actor.user_id,
        descriptionSuffix: `Passive VKYC run · lead ${leadId}`,
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
      mode: "passive",
      channel: sent.channel,
      track_id: track.id,
      attempt_id: attempt.id,
      link_url: linkUrl,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
