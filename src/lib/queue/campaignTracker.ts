// Persists AI dialer campaign state across calls. Every call site here is
// best-effort — if a write fails we log and swallow, because a campaign
// tracking outage must NOT take down the live dialing pipeline. The Redis
// session in dialerSession.ts is the source of truth for "is the dialer
// running"; this module is the source of truth for "what happened?".

import { db } from "@/lib/db";
import { dialerCampaigns, dialerCampaignLeads } from "@/lib/db/schema";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { dialerSession, type DialerProvider } from "./dialerSession";
import { summarizeRegion } from "@/lib/leads/regionSummary";

// Bolna typically resolves a call within ~2 minutes. After 4 minutes with no
// webhook the call is effectively orphaned — flip the row to failed and let
// the queue advance, otherwise the campaign stays "running" forever.
const STALLED_CALLING_THRESHOLD_MS = 4 * 60 * 1000;

type CategoryLabelMap = Record<string, string>;
const CATEGORY_LABELS: CategoryLabelMap = {
  hot: "Hot",
  warm: "Warm",
  cold: "Cold",
  all: "All segments",
  scheduled: "Scheduled",
};

function newId(prefix: string) {
  // Nanoid-style id without a dependency on the nanoid package — sufficient
  // for our PK uniqueness needs (campaign + per-lead row).
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

function autoName(opts: {
  category?: string | null;
  region?: unknown;
}): string {
  const segment = opts.category
    ? (CATEGORY_LABELS[opts.category] ?? opts.category)
    : "All segments";
  const ts = new Date().toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${segment} · ${summarizeRegion(opts.region)} · ${ts}`;
}

export async function createCampaign(opts: {
  queueIds: string[];
  provider: DialerProvider;
  category?: string | null;
  region?: unknown;
  triggeredBy?: string | null;
}): Promise<string | null> {
  try {
    const campaignId = newId("camp");
    const name = autoName({ category: opts.category, region: opts.region });

    await db.insert(dialerCampaigns).values({
      id: campaignId,
      name,
      triggered_by: opts.triggeredBy ?? null,
      provider: opts.provider,
      category: opts.category ?? null,
      region_filter: opts.region ?? null,
      status: "running",
      total_leads: opts.queueIds.length,
    });

    if (opts.queueIds.length > 0) {
      const rows = opts.queueIds.map((leadId, idx) => ({
        id: newId("cl"),
        campaign_id: campaignId,
        lead_id: leadId,
        queue_position: idx,
        status: "pending",
      }));

      // Chunk to keep the bind-parameter count below Postgres' 64k cap on
      // very large queues. 500 rows × ~5 columns = well within limits.
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        await db.insert(dialerCampaignLeads).values(rows.slice(i, i + CHUNK));
      }
    }

    return campaignId;
  } catch (err) {
    console.error("[campaignTracker.createCampaign] failed:", err);
    return null;
  }
}

// Attach the provider call id (Bolna execution_id / ElevenLabs conversation_id)
// to the in-flight campaign-lead row, right after the call is placed. This is
// the link that lets /api/cron/dialer-poll ask the provider "what happened to
// this call?" — without it, a dropped webhook means the call_id is lost and
// the row stays 'calling' until the watchdog times it out.
//
// Resolves campaignId from the Redis dialer session when omitted. Matches the
// most recent 'pending' or 'calling' row for the lead (the same fallback path
// completeCampaignLead uses).
export async function attachBolnaCallId(opts: {
  leadId: string;
  campaignId?: string | null;
  callId: string;
}): Promise<boolean> {
  if (!opts.callId) return false;
  try {
    const campaignId =
      opts.campaignId ?? (await dialerSession.getCampaignId());

    // Scope by campaignId when we have one; otherwise update the most recent
    // active row across all campaigns for this lead. Either way we limit to
    // a single row (the latest in-flight attempt) to avoid clobbering
    // historical rows from prior campaigns.
    const candidateWhere = campaignId
      ? and(
          eq(dialerCampaignLeads.campaign_id, campaignId),
          eq(dialerCampaignLeads.lead_id, opts.leadId),
          inArray(dialerCampaignLeads.status, ["pending", "calling"]),
        )
      : and(
          eq(dialerCampaignLeads.lead_id, opts.leadId),
          inArray(dialerCampaignLeads.status, ["pending", "calling"]),
        );

    const row = await db
      .select({ id: dialerCampaignLeads.id })
      .from(dialerCampaignLeads)
      .where(candidateWhere)
      .orderBy(desc(dialerCampaignLeads.created_at))
      .limit(1);

    const targetId = row[0]?.id;
    if (!targetId) return false;

    await db
      .update(dialerCampaignLeads)
      .set({ bolna_call_id: opts.callId })
      .where(eq(dialerCampaignLeads.id, targetId));

    // Verify the column actually landed — if the write succeeded but a
    // later concurrent update clobbered it, the polling backstop will
    // not be able to find this call. Return false so the caller can
    // log loudly and operators can investigate.
    const check = await db
      .select({ bolna_call_id: dialerCampaignLeads.bolna_call_id })
      .from(dialerCampaignLeads)
      .where(eq(dialerCampaignLeads.id, targetId))
      .limit(1);

    return check[0]?.bolna_call_id === opts.callId;
  } catch (err) {
    console.error("[campaignTracker.attachBolnaCallId] failed:", err);
    return false;
  }
}

// Flip the matching campaign-lead row to 'calling'. Called when a Bolna or
// ElevenLabs trigger is fired for a lead. Resolves campaignId from the Redis
// session if the caller doesn't have it.
export async function markCampaignLeadCalling(opts: {
  leadId: string;
  campaignId?: string | null;
}): Promise<void> {
  try {
    const campaignId =
      opts.campaignId ?? (await dialerSession.getCampaignId());
    if (!campaignId) return;

    await db
      .update(dialerCampaignLeads)
      .set({ status: "calling", started_at: new Date() })
      .where(
        and(
          eq(dialerCampaignLeads.campaign_id, campaignId),
          eq(dialerCampaignLeads.lead_id, opts.leadId),
          // Don't clobber a row that's already 'completed' — webhook may
          // have raced us.
          inArray(dialerCampaignLeads.status, ["pending", "calling"]),
        ),
      );
  } catch (err) {
    console.error("[campaignTracker.markCampaignLeadCalling] failed:", err);
  }
}

// Webhook entrypoint: a call has ended (terminal status) for a lead. Mark
// the in-flight campaign-lead row as completed/failed, bump parent counters.
// Falls back to "most recent calling/pending row for this lead" when the
// Redis session has been GC'd (campaign already wrapped up via timeout).
export async function completeCampaignLead(opts: {
  leadId: string;
  success: boolean;
  bolnaCallId?: string | null;
  outcome?: string | null;
  intentScore?: number | null;
  campaignId?: string | null;
}): Promise<{ campaignId: string | null }> {
  try {
    let campaignId =
      opts.campaignId ?? (await dialerSession.getCampaignId());

    // Fallback: scan for the most recent active row for this lead.
    let targetRowId: string | null = null;
    if (campaignId) {
      const row = await db
        .select({ id: dialerCampaignLeads.id })
        .from(dialerCampaignLeads)
        .where(
          and(
            eq(dialerCampaignLeads.campaign_id, campaignId),
            eq(dialerCampaignLeads.lead_id, opts.leadId),
            inArray(dialerCampaignLeads.status, ["pending", "calling"]),
          ),
        )
        .orderBy(desc(dialerCampaignLeads.created_at))
        .limit(1);
      targetRowId = row[0]?.id ?? null;
    }

    if (!targetRowId) {
      const row = await db
        .select({
          id: dialerCampaignLeads.id,
          campaign_id: dialerCampaignLeads.campaign_id,
        })
        .from(dialerCampaignLeads)
        .where(
          and(
            eq(dialerCampaignLeads.lead_id, opts.leadId),
            inArray(dialerCampaignLeads.status, ["pending", "calling"]),
          ),
        )
        .orderBy(desc(dialerCampaignLeads.created_at))
        .limit(1);
      targetRowId = row[0]?.id ?? null;
      campaignId = row[0]?.campaign_id ?? campaignId;
    }

    if (!targetRowId || !campaignId) return { campaignId: null };

    const newStatus = opts.success ? "completed" : "failed";

    await db
      .update(dialerCampaignLeads)
      .set({
        status: newStatus,
        completed_at: new Date(),
        bolna_call_id: opts.bolnaCallId ?? null,
        call_outcome: opts.outcome ?? null,
        intent_score: opts.intentScore ?? null,
      })
      .where(eq(dialerCampaignLeads.id, targetRowId));

    // calls_made = "calls that actually connected and completed". A failed
    // attempt (no answer, trigger error, no webhook, etc.) bumps failed_leads
    // but NOT calls_made — users were seeing total=4, calls_made=4, failed=1
    // and rightfully asking how 4 calls were made when 1 never happened.
    await db
      .update(dialerCampaigns)
      .set({
        calls_made: opts.success
          ? sql`${dialerCampaigns.calls_made} + 1`
          : sql`${dialerCampaigns.calls_made}`,
        completed_leads: opts.success
          ? sql`${dialerCampaigns.completed_leads} + 1`
          : sql`${dialerCampaigns.completed_leads}`,
        failed_leads: opts.success
          ? sql`${dialerCampaigns.failed_leads}`
          : sql`${dialerCampaigns.failed_leads} + 1`,
      })
      .where(eq(dialerCampaigns.id, campaignId));

    return { campaignId };
  } catch (err) {
    console.error("[campaignTracker.completeCampaignLead] failed:", err);
    return { campaignId: null };
  }
}

// Reconcile leads stuck in 'calling' for too long — call started, no webhook
// arrived. Marks them failed with outcome='no_webhook' and bumps the parent
// counters by the number swept. Idempotent: a late webhook hitting
// completeCampaignLead matches only rows IN ('pending','calling'), so it's a
// no-op for any row this sweep already moved to 'failed'.
//
// If campaignId is null, scans all running campaigns.
export async function sweepStalledCallingLeads(
  campaignId: string | null,
): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - STALLED_CALLING_THRESHOLD_MS);

    const baseWhere = campaignId
      ? and(
          eq(dialerCampaignLeads.campaign_id, campaignId),
          eq(dialerCampaignLeads.status, "calling"),
          lt(dialerCampaignLeads.started_at, cutoff),
        )
      : and(
          eq(dialerCampaignLeads.status, "calling"),
          lt(dialerCampaignLeads.started_at, cutoff),
        );

    const stalled = await db
      .select({
        id: dialerCampaignLeads.id,
        campaign_id: dialerCampaignLeads.campaign_id,
        lead_id: dialerCampaignLeads.lead_id,
        bolna_call_id: dialerCampaignLeads.bolna_call_id,
        started_at: dialerCampaignLeads.started_at,
      })
      .from(dialerCampaignLeads)
      .where(baseWhere);

    if (stalled.length === 0) return 0;

    // Per-row log so operators can correlate with Bolna / ElevenLabs
    // dashboards. A bare count tells us how many but not which ones.
    for (const r of stalled) {
      console.warn("[CAMPAIGN] sweeping stalled calling row (no_webhook)", {
        campaignLeadId: r.id,
        campaignId: r.campaign_id,
        leadId: r.lead_id,
        providerCallId: r.bolna_call_id,
        startedAt: r.started_at,
      });
    }

    const ids = stalled.map((r) => r.id);
    await db
      .update(dialerCampaignLeads)
      .set({
        status: "failed",
        completed_at: new Date(),
        call_outcome: "no_webhook",
      })
      .where(inArray(dialerCampaignLeads.id, ids));

    // Bump parent counters per-campaign — a sweep across all campaigns can
    // touch multiple, so group by campaign_id.
    const perCampaign = new Map<string, number>();
    for (const row of stalled) {
      perCampaign.set(
        row.campaign_id,
        (perCampaign.get(row.campaign_id) ?? 0) + 1,
      );
    }

    // No-webhook sweeps are failures — bump failed_leads only. calls_made
    // stays unchanged so it reflects "calls that actually went through".
    for (const [cId, n] of perCampaign) {
      await db
        .update(dialerCampaigns)
        .set({
          failed_leads: sql`${dialerCampaigns.failed_leads} + ${n}`,
        })
        .where(eq(dialerCampaigns.id, cId));
    }

    console.log(
      `[CAMPAIGN] swept ${stalled.length} stalled calling rows` +
        (campaignId ? ` on campaign ${campaignId}` : " across all campaigns"),
    );
    return stalled.length;
  } catch (err) {
    console.error("[campaignTracker.sweepStalledCallingLeads] failed:", err);
    return 0;
  }
}

export async function finalizeCampaign(
  campaignId: string | null,
  status: "completed" | "stopped" | "failed",
  stoppedBy?: string | null,
): Promise<void> {
  if (!campaignId) return;
  try {
    await db
      .update(dialerCampaigns)
      .set({
        status,
        completed_at: new Date(),
        stopped_by: stoppedBy ?? null,
      })
      .where(eq(dialerCampaigns.id, campaignId));
  } catch (err) {
    console.error("[campaignTracker.finalizeCampaign] failed:", err);
  }
}

// Drain in-flight rows when a campaign is stopped mid-call. The active call
// won't generate a clean completion webhook (or arrives well after Stop),
// leaving the row stuck at 'calling'. Flip it to 'failed' so the detail
// view shows the user's accurate picture: "we attempted, the user pulled
// the plug." Pending rows stay 'pending' — they were never attempted, and
// the parent's status='stopped' is enough context.
//
// Idempotent: a late-arriving webhook calls completeCampaignLead which
// only matches rows IN ('pending','calling'), so it becomes a no-op.
export async function drainActiveCampaignLeads(
  campaignId: string | null,
): Promise<void> {
  if (!campaignId) return;
  try {
    // Fetch first so we can compute how much to bump the parent counters.
    const callingRows = await db
      .select({ id: dialerCampaignLeads.id })
      .from(dialerCampaignLeads)
      .where(
        and(
          eq(dialerCampaignLeads.campaign_id, campaignId),
          eq(dialerCampaignLeads.status, "calling"),
        ),
      );

    if (callingRows.length === 0) return;

    await db
      .update(dialerCampaignLeads)
      .set({
        status: "failed",
        completed_at: new Date(),
        call_outcome: "stopped_by_user",
      })
      .where(
        and(
          eq(dialerCampaignLeads.campaign_id, campaignId),
          eq(dialerCampaignLeads.status, "calling"),
        ),
      );

    // User-stopped drain is a failure path — bump failed_leads only, not
    // calls_made.
    const n = callingRows.length;
    await db
      .update(dialerCampaigns)
      .set({
        failed_leads: sql`${dialerCampaigns.failed_leads} + ${n}`,
      })
      .where(eq(dialerCampaigns.id, campaignId));
  } catch (err) {
    console.error("[campaignTracker.drainActiveCampaignLeads] failed:", err);
  }
}
