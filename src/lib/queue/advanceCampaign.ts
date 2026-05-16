// DB-driven "place the next call in this campaign" primitive.
//
// Why this exists: the previous design hung the queue state off a Redis
// dialer session (TTL = 2h, lost on Upstash quota exhaustion, lost on
// deploy, lost across serverless instances). For a campaign with 200+
// leads that may take multiple hours, the session vanishing mid-run left
// the queue permanently stuck even though the DB had a full list of
// pending leads waiting their turn.
//
// The new contract:
//   - dialer_campaign_leads is the source of truth for queue position
//   - advanceCampaign atomically claims the next pending row using
//     FOR UPDATE SKIP LOCKED so two concurrent advances (e.g. webhook
//     racing with the polling backstop) can't both pick the same row
//   - When the queue exhausts, the campaign is finalized as completed
//
// Callers:
//   - /api/ai-dialer/start (fires the first call server-side)
//   - finalizeBolnaCall / finalizeElevenLabsCall (after each call ends)
//   - the watchdog and force-stop are unaffected — they finalize the
//     campaign without going through advanceCampaign

import { db } from "@/lib/db";
import {
  dealerLeads,
  dialerCampaigns,
  dialerCampaignLeads,
} from "@/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";
import {
  attachBolnaCallId,
  finalizeCampaign,
} from "./campaignTracker";
import { triggerBolnaCall } from "@/lib/ai/bolna_ai/triggerCall";
import { triggerElevenLabsCall } from "@/lib/ai/elevenlabs/triggerCall";

export type AdvanceResult =
  | { kind: "placed"; leadId: string; campaignLeadId: string; callId: string | null }
  | { kind: "no-pending"; finalized: boolean }
  | { kind: "skipped"; reason: string }
  | { kind: "campaign-not-running" }
  | { kind: "error"; error: string };

export type AdvanceOptions = {
  // Optional delay before the next call. Defaults to 0. The webhook path
  // historically waited 5s — kept as a caller option, not hard-coded.
  preCallDelayMs?: number;
};

// Atomically claim the next pending row. Uses SKIP LOCKED so concurrent
// callers (webhook + polling tick) won't both pick the same row, and
// returns the locked row's id + lead_id so the caller can place the call
// without a TOCTOU window.
async function claimNextPending(campaignId: string): Promise<{
  campaignLeadId: string;
  leadId: string;
} | null> {
  // Use Drizzle's raw SQL for the CTE — gives us SKIP LOCKED which the
  // builder helpers don't expose. The subquery picks one pending row by
  // queue_position, locks it, and the outer UPDATE flips it to calling.
  const rows = await db.execute<{ id: string; lead_id: string }>(sql`
    WITH next_row AS (
      SELECT id
      FROM dialer_campaign_leads
      WHERE campaign_id = ${campaignId}
        AND status = 'pending'
      ORDER BY queue_position ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE dialer_campaign_leads
    SET status = 'calling',
        started_at = NOW()
    WHERE id IN (SELECT id FROM next_row)
    RETURNING id, lead_id
  `);

  // drizzle-orm + postgres-js returns rows on .execute() as the array
  // directly or under .rows depending on driver. Handle both.
  const row =
    (rows as unknown as { rows?: Array<{ id: string; lead_id: string }> })
      .rows?.[0] ??
    (rows as unknown as Array<{ id: string; lead_id: string }>)[0];

  if (!row) return null;
  return { campaignLeadId: row.id, leadId: row.lead_id };
}

// Are there any rows still calling in this campaign? Used to decide
// whether to finalize the campaign as completed (no pending AND no
// calling rows = truly done).
async function hasCallingRows(campaignId: string): Promise<boolean> {
  const r = await db
    .select({ id: dialerCampaignLeads.id })
    .from(dialerCampaignLeads)
    .where(
      and(
        eq(dialerCampaignLeads.campaign_id, campaignId),
        eq(dialerCampaignLeads.status, "calling"),
      ),
    )
    .limit(1);
  return r.length > 0;
}

export async function advanceCampaign(
  campaignId: string,
  opts: AdvanceOptions = {},
): Promise<AdvanceResult> {
  try {
    // Confirm the campaign is still running before doing any work — a
    // force-stop or prior finalize means we should not place more calls.
    const cmp = await db
      .select({
        id: dialerCampaigns.id,
        status: dialerCampaigns.status,
        provider: dialerCampaigns.provider,
      })
      .from(dialerCampaigns)
      .where(eq(dialerCampaigns.id, campaignId))
      .limit(1);

    if (cmp.length === 0 || cmp[0].status !== "running") {
      return { kind: "campaign-not-running" };
    }

    const provider = (cmp[0].provider || "bolna").toLowerCase();

    // Pre-call delay (legacy webhook path used 5s to space requests).
    if (opts.preCallDelayMs && opts.preCallDelayMs > 0) {
      await new Promise((r) => setTimeout(r, opts.preCallDelayMs));
    }

    // Inner retry: if we claim a row whose lead has no phone, skip it
    // (mark failed + bump counters), try the next. Cap iterations so a
    // bad batch of phone-less leads can't loop forever. 100 covers the
    // common case of an imported batch with a contiguous cluster of bad
    // numbers — 20 was too tight and stalled real campaigns.
    const MAX_SKIPS = 100;
    for (let i = 0; i < MAX_SKIPS; i++) {
      const claimed = await claimNextPending(campaignId);
      if (!claimed) {
        // No more pending rows. If nothing is calling either, the
        // campaign is genuinely done — finalize. Otherwise leave it
        // running so the in-flight call's webhook/poll completes the
        // last row, which will then re-enter advanceCampaign and
        // observe the empty queue.
        const stillCalling = await hasCallingRows(campaignId);
        if (!stillCalling) {
          await finalizeCampaign(campaignId, "completed");
          return { kind: "no-pending", finalized: true };
        }
        return { kind: "no-pending", finalized: false };
      }

      const lead = await db
        .select({
          id: dealerLeads.id,
          phone: dealerLeads.phone,
        })
        .from(dealerLeads)
        .where(eq(dealerLeads.id, claimed.leadId))
        .limit(1);

      if (lead.length === 0 || !lead[0].phone) {
        // Mark the claimed row failed with a clear outcome and continue
        // to the next pending row. Bump counters so the campaign card
        // reflects the progress. Log per-row so operators can audit
        // which leads were skipped in a bad batch.
        console.warn("[advanceCampaign] skipping no-phone lead", {
          campaignId,
          leadId: claimed.leadId,
          campaignLeadId: claimed.campaignLeadId,
        });
        await db
          .update(dialerCampaignLeads)
          .set({
            status: "failed",
            completed_at: new Date(),
            call_outcome: "no_phone",
          })
          .where(eq(dialerCampaignLeads.id, claimed.campaignLeadId));
        // Failure path — bump failed_leads only. calls_made stays unchanged
        // so it reflects "calls that actually went through to the dealer".
        await db
          .update(dialerCampaigns)
          .set({
            failed_leads: sql`${dialerCampaigns.failed_leads} + 1`,
          })
          .where(eq(dialerCampaigns.id, campaignId));
        continue;
      }

      // Place the call via the right provider.
      let trigResult: { success: boolean; call_id?: string; error?: string };
      try {
        if (provider === "elevenlabs") {
          trigResult = (await triggerElevenLabsCall({
            phone: lead[0].phone,
            leadId: lead[0].id,
          })) as typeof trigResult;
        } else {
          trigResult = (await triggerBolnaCall({
            phone: lead[0].phone,
            leadId: lead[0].id,
          })) as typeof trigResult;
        }
      } catch (err) {
        // Trigger threw — mark this row failed and CONTINUE to the next
        // pending lead. Previously we returned an error here, which left
        // the caller (webhook/poll) thinking the advance failed and
        // stalled the whole campaign on a single provider exception.
        console.error(
          "[advanceCampaign] trigger threw, skipping lead",
          {
            campaignId,
            leadId: lead[0].id,
            campaignLeadId: claimed.campaignLeadId,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        await db
          .update(dialerCampaignLeads)
          .set({
            status: "failed",
            completed_at: new Date(),
            call_outcome: "trigger_exception",
          })
          .where(eq(dialerCampaignLeads.id, claimed.campaignLeadId));
        // Failure path — only bump failed_leads.
        await db
          .update(dialerCampaigns)
          .set({
            failed_leads: sql`${dialerCampaigns.failed_leads} + 1`,
          })
          .where(eq(dialerCampaigns.id, campaignId));
        continue;
      }

      if (!trigResult.success) {
        // Provider rejected the call (rate limit, invalid number, etc.).
        // Mark failed and continue advancing so we don't stall on a bad
        // row. The trigger keeps the row out of "calling" forever
        // otherwise.
        await db
          .update(dialerCampaignLeads)
          .set({
            status: "failed",
            completed_at: new Date(),
            call_outcome: "trigger_failed",
          })
          .where(eq(dialerCampaignLeads.id, claimed.campaignLeadId));
        // Failure path — only bump failed_leads.
        await db
          .update(dialerCampaigns)
          .set({
            failed_leads: sql`${dialerCampaigns.failed_leads} + 1`,
          })
          .where(eq(dialerCampaigns.id, campaignId));
        continue;
      }

      // Success path: attach the provider call id to the row so the
      // polling backstop can look up status later. If the attach fails,
      // log loudly — the call is live but invisible to the poll, so it
      // can only be recovered by the 4-min stalled-call watchdog.
      if (trigResult.call_id) {
        const attached = await attachBolnaCallId({
          leadId: lead[0].id,
          campaignId,
          callId: trigResult.call_id,
        });
        if (!attached) {
          console.error(
            "[advanceCampaign] FAILED to attach call_id — polling cannot recover this call",
            {
              campaignId,
              leadId: lead[0].id,
              campaignLeadId: claimed.campaignLeadId,
              callId: trigResult.call_id,
            },
          );
        }
      }

      return {
        kind: "placed",
        leadId: lead[0].id,
        campaignLeadId: claimed.campaignLeadId,
        callId: trigResult.call_id ?? null,
      };
    }

    // Exhausted the inner retry without placing a call. The campaign is
    // not finalized — the caller should re-invoke advanceCampaign (or
    // the watchdog will pick it up at the next cron tick).
    console.warn("[advanceCampaign] max-skips-exceeded — campaign will resume on next webhook/cron tick", {
      campaignId,
      maxSkips: MAX_SKIPS,
    });
    return { kind: "skipped", reason: "max-skips-exceeded" };
  } catch (err) {
    console.error("[advanceCampaign] failed:", err);
    return {
      kind: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
