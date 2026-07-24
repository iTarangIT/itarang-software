/**
 * POST /api/nbfc/fi/[leadId]/action — BRD Addendum V0.3.1 §10 (Model C).
 *
 *   assign       → pick an agent from the directory; opens the 48h SLA, mints a
 *                  single-use link, and dispatches it (status assigned→in_progress).
 *   resend_link  → re-mint + re-dispatch the link to the same agent.
 *   decide       → Coordinator review outcome Pass / Fail (§10.8.2).
 *   reinspect    → request a re-visit: close the current attempt and open a new
 *                  one (same or new agent), SLA restarts (§10.10).
 *   reopen       → NBFC Admin re-opens a decided attempt for re-review (§10.8.2).
 *
 * Role: `fi_coordinator` or `nbfc_admin` (reopen is admin-only). The AGENT does
 * not act here — they submit via the public token-gated field form.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { fieldInvestigations, leads, nbfcServiceConfig } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { resolveServiceOptIn } from "@/lib/nbfc/service-opt-in";
import { getActiveAssignment } from "@/lib/nbfc/vkyc";
import { generateFiLinkToken, geocodeAddress, getCurrentFiTrack, slaDueFrom } from "@/lib/nbfc/fi";
import { getFiAgent } from "@/lib/nbfc/fi-agents";
import { dispatchFiLink } from "@/lib/nbfc/fi-dispatch";
import { assertNotHaltedByFailure } from "@/lib/nbfc/track-gate";
import { publicOrigin, PublicOriginError } from "@/lib/public-origin";
import { notifyFiEvent } from "@/lib/notifications/events";
import { tenantDisplayName } from "@/lib/notifications/emit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  action: z.enum(["assign", "resend_link", "decide", "reinspect", "reopen"]),
  agent_id: z.string().uuid().optional(),
  // Explicit link channel chosen by the Coordinator (assign / resend / reinspect).
  channel: z.enum(["email", "sms", "whatsapp"]).optional(),
  decision: z.enum(["pass", "fail"]).optional(),
  reason: z.string().max(4000).optional(),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

async function leadSummary(leadId: string) {
  const [l] = await db
    .select({
      full_name: leads.full_name,
      owner_name: leads.owner_name,
      current_address: leads.current_address,
      permanent_address: leads.permanent_address,
      local_address: leads.local_address,
      city: leads.city,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  return {
    name: l?.full_name || l?.owner_name || "Customer",
    address: l?.current_address || l?.permanent_address || l?.local_address || null,
    city: l?.city ?? null,
  };
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
    const d = parsed.data;

    const actor = await resolveActor(req.headers);
    const canAct = actor.role === "fi_coordinator" || actor.role === "nbfc_admin";
    if (!canAct) {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role '${actor.role}' cannot act on FI; fi_coordinator or nbfc_admin required` },
        { status: 403 },
      );
    }

    const assignment = await getActiveAssignment(leadId, actor.tenant_id);
    if (!assignment) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: no assignment for this tenant" }, { status: 400 });
    }
    const nbfcId = assignment.nbfc_id;
    const now = new Date();
    // Build the agent link from the configured PUBLIC origin (NEXT_PUBLIC_APP_URL),
    // NOT req.nextUrl.origin — the latter is the dev/internal bind host (e.g.
    // localhost:3003) which is unreachable from the agent's phone, producing the
    // ERR_CONNECTION_REFUSED the agent saw. Mirrors the VKYC initiate route.
    let publicBase: string;
    try {
      publicBase = publicOrigin({ req });
    } catch (err) {
      const msg = err instanceof PublicOriginError ? err.message : "Cannot determine public origin";
      return NextResponse.json({ ok: false, error: `Server misconfig: ${msg}` }, { status: 500 });
    }
    const linkUrl = (token: string) => `${publicBase}/fi/${token}`;

    // ── assign ────────────────────────────────────────────────────────────
    if (d.action === "assign") {
      if (!d.agent_id) {
        return NextResponse.json({ ok: false, error: "BAD_REQUEST: agent_id required" }, { status: 400 });
      }
      // FI must be opted in. Read LIVE (resolveServiceOptIn) — an NBFC that has
      // switched FI off cannot assign an agent on any lead.
      const enabled = (
        await resolveServiceOptIn(actor.tenant_id, assignment.snapshot)
      ).fi_enabled;
      if (!enabled) {
        return NextResponse.json({ ok: false, error: "BAD_REQUEST: Field Investigation is not opted in for this NBFC" }, { status: 400 });
      }
      await assertNotHaltedByFailure(leadId, "fi");

      const agent = await getFiAgent(d.agent_id, actor.tenant_id);
      if (!agent || !agent.active) {
        return NextResponse.json({ ok: false, error: "BAD_REQUEST: agent not found or inactive" }, { status: 400 });
      }

      const existing = await getCurrentFiTrack(leadId, nbfcId);
      if (existing && !["pending", "assigned", "in_progress", "not_applicable"].includes(existing.status)) {
        return NextResponse.json(
          { ok: false, error: "BAD_REQUEST: this attempt is already submitted/decided — use Request re-inspection" },
          { status: 400 },
        );
      }

      const sla = slaDueFrom(now);
      const token = generateFiLinkToken();
      const lead = await leadSummary(leadId);
      const geo = await geocodeAddress(lead.address);

      const base = {
        status: "assigned",
        assigned_agent_id: agent.id,
        assigned_to: agent.name,
        assigned_by: actor.user_id,
        assigned_at: now,
        sla_due_at: sla,
        sla_breached: false,
        link_token: token,
        link_expires_at: sla,
        stated_lat: geo ? String(geo.lat) : null,
        stated_lng: geo ? String(geo.lng) : null,
        updated_at: now,
      };
      let fiId: string;
      if (existing) {
        await db.update(fieldInvestigations).set(base).where(eq(fieldInvestigations.id, existing.id));
        fiId = existing.id;
      } else {
        const [row] = await db
          .insert(fieldInvestigations)
          .values({ lead_id: leadId, nbfc_id: nbfcId, tenant_id: actor.tenant_id, attempt_no: 1, is_current: true, ...base })
          .returning({ id: fieldInvestigations.id });
        fiId = row.id;
      }

      const sent = await dispatchFiLink({ agent, url: linkUrl(token), customerName: lead.name, expiresAt: sla, channel: d.channel });
      if (sent.ok) {
        await db
          .update(fieldInvestigations)
          .set({ status: "in_progress", link_sent_at: now, link_channel: sent.channel, updated_at: new Date() })
          .where(eq(fieldInvestigations.id, fiId));
        // NBFC → agent. Recorded so the chain (requested → assigned → submitted
        // → reviewed) reads end to end and it is always clear who holds it.
        await notifyFiEvent({
          leadId,
          event: "assigned",
          nbfcName: await tenantDisplayName(actor.tenant_id),
          tenantId: actor.tenant_id,
          agentName: agent.name,
        });
        return NextResponse.json({ ok: true, status: "in_progress", channel: sent.channel, sla_due_at: sla });
      }
      // Link minted (row saved) but dispatch failed — Coordinator can resend.
      return NextResponse.json(
        { ok: false, status: "assigned", error: `Link created but dispatch failed: ${sent.error}. Use "Resend link".` },
        { status: 502 },
      );
    }

    const track = await getCurrentFiTrack(leadId, nbfcId);
    if (!track) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: no current FI attempt — assign an agent first" }, { status: 400 });
    }

    // ── resend_link ───────────────────────────────────────────────────────
    if (d.action === "resend_link") {
      if (!track.assigned_agent_id) {
        return NextResponse.json({ ok: false, error: "BAD_REQUEST: no agent assigned" }, { status: 400 });
      }
      const agent = await getFiAgent(track.assigned_agent_id, actor.tenant_id);
      if (!agent) return NextResponse.json({ ok: false, error: "BAD_REQUEST: agent not found" }, { status: 400 });
      const token = generateFiLinkToken();
      const expires = track.sla_due_at ? new Date(track.sla_due_at) : slaDueFrom(now);
      const lead = await leadSummary(leadId);
      await db
        .update(fieldInvestigations)
        .set({ link_token: token, link_expires_at: expires, updated_at: now })
        .where(eq(fieldInvestigations.id, track.id));
      const sent = await dispatchFiLink({ agent, url: linkUrl(token), customerName: lead.name, expiresAt: expires, channel: d.channel });
      if (!sent.ok) {
        return NextResponse.json({ ok: false, error: `Dispatch failed: ${sent.error}` }, { status: 502 });
      }
      await db
        .update(fieldInvestigations)
        .set({ status: track.status === "assigned" ? "in_progress" : track.status, link_sent_at: now, link_channel: sent.channel, updated_at: new Date() })
        .where(eq(fieldInvestigations.id, track.id));
      return NextResponse.json({ ok: true, channel: sent.channel });
    }

    // ── decide (Pass / Fail) ──────────────────────────────────────────────
    if (d.action === "decide") {
      if (track.status !== "submitted") {
        return NextResponse.json({ ok: false, error: "BAD_REQUEST: only a submitted visit can be decided" }, { status: 400 });
      }
      if (!d.decision) {
        return NextResponse.json({ ok: false, error: "BAD_REQUEST: decision (pass|fail) required" }, { status: 400 });
      }
      if (d.decision === "fail" && !d.reason?.trim()) {
        return NextResponse.json({ ok: false, error: "BAD_REQUEST: a reason is required to fail (§10.8.2)" }, { status: 400 });
      }
      await db
        .update(fieldInvestigations)
        .set({
          status: d.decision === "pass" ? "passed" : "failed",
          decision: d.decision,
          decision_reason: d.reason?.trim() || null,
          outcome: d.decision, // legacy mirror
          decided_by: actor.user_id,
          decided_at: now,
          reviewed_by: actor.user_id,
          reviewed_at: now,
          updated_at: now,
        })
        .where(eq(fieldInvestigations.id, track.id));
      await notifyFiEvent({
        leadId,
        event: "reviewed",
        nbfcName: await tenantDisplayName(actor.tenant_id),
        tenantId: actor.tenant_id,
        agentName: track.assigned_to,
        outcome: d.decision === "pass" ? "Passed" : "Failed",
        notes: d.reason?.trim() || null,
      });
      return NextResponse.json({ ok: true, status: d.decision === "pass" ? "passed" : "failed" });
    }

    // ── reinspect ─────────────────────────────────────────────────────────
    if (d.action === "reinspect") {
      if (!d.agent_id) {
        return NextResponse.json({ ok: false, error: "BAD_REQUEST: agent_id required for re-inspection" }, { status: 400 });
      }
      if (!d.reason?.trim()) {
        return NextResponse.json({ ok: false, error: "BAD_REQUEST: a reason is required to request re-inspection (§10.8.2)" }, { status: 400 });
      }
      // Re-inspection cap (§10.8.2 / §10.10) — default unlimited.
      const cfg = await db
        .select({ fiConfig: nbfcServiceConfig.fi_config })
        .from(nbfcServiceConfig)
        .where(eq(nbfcServiceConfig.tenant_id, actor.tenant_id))
        .limit(1);
      const cap = (cfg[0]?.fiConfig as { reinspection_cap?: number | null } | undefined)?.reinspection_cap ?? null;
      if (cap != null && track.attempt_no >= cap) {
        return NextResponse.json({ ok: false, error: `BAD_REQUEST: re-inspection cap (${cap}) reached` }, { status: 400 });
      }

      const agent = await getFiAgent(d.agent_id, actor.tenant_id);
      if (!agent || !agent.active) {
        return NextResponse.json({ ok: false, error: "BAD_REQUEST: agent not found or inactive" }, { status: 400 });
      }

      const sla = slaDueFrom(now);
      const token = generateFiLinkToken();
      const lead = await leadSummary(leadId);
      // Close the current attempt (audit) and open a fresh one (SLA restarts) —
      // atomically. Without a transaction a failed insert would leave the closed
      // row at is_current=false with NO replacement, orphaning the lead ("no
      // current FI attempt"). The partial unique index allows only ONE is_current
      // row per (lead × NBFC), so every current row must be closed BEFORE insert.
      const row = await db.transaction(async (tx) => {
        await tx
          .update(fieldInvestigations)
          .set({
            status: "re_inspection_requested",
            decision: "re_inspection",
            decision_reason: d.reason.trim(),
            decided_by: actor.user_id,
            decided_at: now,
            is_current: false,
            updated_at: now,
          })
          .where(eq(fieldInvestigations.id, track.id));
        // Defensive: close any other current row for this pair (legacy data may
        // have stragglers) so the partial unique index can never be violated.
        await tx
          .update(fieldInvestigations)
          .set({ is_current: false, updated_at: now })
          .where(
            and(
              eq(fieldInvestigations.lead_id, leadId),
              eq(fieldInvestigations.nbfc_id, nbfcId),
              eq(fieldInvestigations.is_current, true),
            ),
          );
        const [inserted] = await tx
          .insert(fieldInvestigations)
          .values({
            lead_id: leadId,
            nbfc_id: nbfcId,
            tenant_id: actor.tenant_id,
            attempt_no: track.attempt_no + 1,
            is_current: true,
            status: "assigned",
            assigned_agent_id: agent.id,
            assigned_to: agent.name,
            assigned_by: actor.user_id,
            assigned_at: now,
            sla_due_at: sla,
            link_token: token,
            link_expires_at: sla,
            stated_lat: track.stated_lat,
            stated_lng: track.stated_lng,
            created_at: now,
            updated_at: now,
          })
          .returning({ id: fieldInvestigations.id });
        return inserted;
      });

      const sent = await dispatchFiLink({ agent, url: linkUrl(token), customerName: lead.name, expiresAt: sla, channel: d.channel });
      if (sent.ok) {
        await db
          .update(fieldInvestigations)
          .set({ status: "in_progress", link_sent_at: now, link_channel: sent.channel, updated_at: new Date() })
          .where(eq(fieldInvestigations.id, row.id));
      }
      // A re-inspection also reaches the DEALER — it usually means the customer
      // has to be available again, which is theirs to arrange.
      await notifyFiEvent({
        leadId,
        event: "reinspection",
        nbfcName: await tenantDisplayName(actor.tenant_id),
        tenantId: actor.tenant_id,
        agentName: agent.name,
        notes: d.reason.trim(),
      });
      return NextResponse.json({ ok: true, status: sent.ok ? "in_progress" : "assigned", attempt_no: track.attempt_no + 1, channel: sent.channel });
    }

    // ── reopen (NBFC Admin) ───────────────────────────────────────────────
    if (d.action === "reopen") {
      if (actor.role !== "nbfc_admin") {
        return NextResponse.json({ ok: false, error: "FORBIDDEN: only nbfc_admin can reopen a decision" }, { status: 403 });
      }
      if (track.status !== "passed" && track.status !== "failed") {
        return NextResponse.json({ ok: false, error: "BAD_REQUEST: only a decided attempt can be reopened" }, { status: 400 });
      }
      if (!d.reason?.trim()) {
        return NextResponse.json({ ok: false, error: "BAD_REQUEST: a reason is required to reopen (§10.8.2)" }, { status: 400 });
      }
      await db
        .update(fieldInvestigations)
        .set({
          status: "submitted",
          decision: null,
          decision_reason: null,
          outcome: null,
          decided_by: null,
          decided_at: null,
          reopened_by: actor.user_id,
          reopened_at: now,
          reopen_reason: d.reason.trim(),
          updated_at: now,
        })
        .where(eq(fieldInvestigations.id, track.id));
      return NextResponse.json({ ok: true, status: "submitted" });
    }

    return NextResponse.json({ ok: false, error: "BAD_REQUEST: unknown action" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Drizzle wraps DB failures in a verbose "Failed query: …" message and hides
    // the actual Postgres error (constraint name, detail) on `.cause`. Prefer the
    // concise cause so the UI shows e.g. "duplicate key value violates …" rather
    // than the full SQL+params dump.
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : undefined;
    return NextResponse.json({ ok: false, error: cause ?? msg }, { status: statusFromError(msg) });
  }
}
