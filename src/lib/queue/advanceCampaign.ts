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
  recordAttemptOutcome,
  syncCampaignCounters,
} from "./campaignTracker";
import { triggerBolnaCall } from "@/lib/ai/bolna_ai/triggerCall";
import { triggerElevenLabsCall } from "@/lib/ai/elevenlabs/triggerCall";
import {
  AI_CONNECTED_CALL_SQL,
  isAiDialable,
} from "@/lib/ai-dialer/exclusionFilter";
import { classifyCallEnd } from "@/lib/ai-dialer/campaignLeadStatus";
import {
  nextWindowOpenSql,
  pauseForWindow,
  windowOpenSql,
  type ScheduleMode,
} from "./campaignWindow";

export type AdvanceResult =
  | { kind: "placed"; leadId: string; campaignLeadId: string; callId: string | null }
  | { kind: "no-pending"; finalized: boolean }
  // E-315 — nothing is dialable right now, but unreached leads have automatic
  // retries booked. The campaign stays 'running' (idle) and the 60s
  // wakeDueRetries tick re-enters here once the earliest one is due.
  | { kind: "waiting-retry"; nextAt: Date | null }
  | { kind: "skipped"; reason: string }
  | { kind: "campaign-not-running" }
  // E-254 — the calling window is shut. The campaign has been parked (see
  // pauseForWindow) and no call was placed. This is a NORMAL outcome, not an
  // error: callers that report "did the first call go out?" must not turn it
  // into a failure message.
  | {
      kind: "window-closed";
      status: "scheduled" | "paused";
      resumeAt: Date | null;
    }
  | { kind: "error"; error: string };

export type AdvanceOptions = {
  // Optional delay before the next call. Defaults to 0. The webhook path
  // historically waited 5s — kept as a caller option, not hard-coded.
  preCallDelayMs?: number;
};

type ClaimedRow = { id: string; lead_id: string; attempt_count: number };

// Atomically claim the next row to dial. Uses SKIP LOCKED so concurrent
// callers (webhook + polling tick) won't both pick the same row, and
// returns the locked row's id + lead_id so the caller can place the call
// without a TOCTOU window.
//
// E-315 — a row is dialable when it has never been dialled ('pending') OR its
// automatic retry is due (next_attempt_at <= now()). Due retries go FIRST: a
// 15-minute busy redial must not wait behind a 200-lead first pass. The claim
// counts the dial (attempt_count + 1), consumes the booking (next_attempt_at
// NULL) and clears the previous attempt's provider id, so a late webhook for
// that earlier call cannot close this one (completeCampaignLead compares ids).
// It clears the previous outcome too, or a redial in flight would show the last
// call's "INVITE failed" until its own result lands (attempt_history keeps it).
async function claimNextPending(campaignId: string): Promise<{
  campaignLeadId: string;
  leadId: string;
  attemptCount: number;
} | null> {
  // Use Drizzle's raw SQL for the CTE — gives us SKIP LOCKED which the
  // builder helpers don't expose. The subquery picks one row, locks it, and
  // the outer UPDATE flips it to calling.
  const rows = await db.execute<ClaimedRow>(sql`
    WITH next_row AS (
      SELECT id
      FROM dialer_campaign_leads
      WHERE campaign_id = ${campaignId}
        AND (
          status = 'pending'
          OR (next_attempt_at IS NOT NULL AND next_attempt_at <= now())
        )
      ORDER BY next_attempt_at ASC NULLS LAST, queue_position ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE dialer_campaign_leads
    SET status = 'calling',
        started_at = NOW(),
        attempt_count = attempt_count + 1,
        next_attempt_at = NULL,
        bolna_call_id = NULL,
        call_outcome = NULL
    WHERE id IN (SELECT id FROM next_row)
    RETURNING id, lead_id, attempt_count
  `);

  // drizzle-orm + postgres-js returns rows on .execute() as the array
  // directly or under .rows depending on driver. Handle both.
  const row =
    (rows as unknown as { rows?: ClaimedRow[] }).rows?.[0] ??
    (rows as unknown as ClaimedRow[])[0];

  if (!row) return null;
  return {
    campaignLeadId: row.id,
    leadId: row.lead_id,
    attemptCount: Number(row.attempt_count),
  };
}

// E-315 — the earliest booked retry in this campaign, or null when none.
async function nextScheduledRetry(campaignId: string): Promise<Date | null> {
  const r = await db
    .select({ at: sql<Date | null>`min(${dialerCampaignLeads.next_attempt_at})` })
    .from(dialerCampaignLeads)
    .where(eq(dialerCampaignLeads.campaign_id, campaignId));
  const at = r[0]?.at;
  return at ? new Date(at) : null;
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

// Is anything still waiting to be dialled? Consulted only when the window has
// just shut — see the gate below for why an empty queue must NOT park.
async function hasPendingRows(campaignId: string): Promise<boolean> {
  const r = await db
    .select({ id: dialerCampaignLeads.id })
    .from(dialerCampaignLeads)
    .where(
      and(
        eq(dialerCampaignLeads.campaign_id, campaignId),
        eq(dialerCampaignLeads.status, "pending"),
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
        region_filter: dialerCampaigns.region_filter,
        // E-254 — the calling window, evaluated in the SAME round trip as the
        // status read. Both are SQL expressions over now(), so the decision
        // uses the database's clock; a JS Date here would let the web process
        // and the resume ticker disagree about whether the window is open.
        schedule_mode: dialerCampaigns.schedule_mode,
        window_open: windowOpenSql(),
        next_open_at: nextWindowOpenSql(),
      })
      .from(dialerCampaigns)
      .where(eq(dialerCampaigns.id, campaignId))
      .limit(1);

    if (cmp.length === 0 || cmp[0].status !== "running") {
      return { kind: "campaign-not-running" };
    }

    // E-254 — THE BUSINESS-HOURS GATE.
    //
    // Placed here, immediately after the status check, because every path that
    // dials — /start, /lists/[id]/start, /resume, /recall-failed, /advance, the
    // webhook chain, the 30s poll and the 2m watchdog — funnels through this
    // one function. One gate covers all of them; a per-caller check would leave
    // whichever caller is added next uncovered.
    //
    // Before the preCallDelayMs sleep below, so a campaign whose window just
    // shut parks immediately instead of idling 5 seconds first.
    //
    // A call already in flight is NOT cancelled — the window governs when a
    // call may START, matching E-228's window_end column comment. The in-flight
    // call finishes, its webhook re-enters here, and this branch parks the
    // campaign then.
    if (!cmp[0].window_open) {
      // Nothing left to dial? Then the window is irrelevant — fall through to
      // the exhaustion branch below so the campaign finalizes as 'completed'.
      //
      // Parking it instead would strand it: a recurring campaign would sit in
      // 'scheduled' until its next window merely to discover it was already
      // done, and a SINGLE run would land in 'paused' with 0 pending, where the
      // Resume button is hidden (canResume requires pendingLeads > 0) and no
      // ticker claims it. That dead end is reachable any time the last call of
      // the day finishes after the end time.
      if (await hasPendingRows(campaignId)) {
        const mode = (cmp[0].schedule_mode || "now") as ScheduleMode;
        const nextOpenAt = cmp[0].next_open_at
          ? new Date(cmp[0].next_open_at)
          : null;
        const parked = await pauseForWindow(campaignId, mode, nextOpenAt);
        console.log("[advanceCampaign] calling window shut — campaign parked", {
          campaignId,
          mode,
          status: parked.status,
          resumeAt: parked.resumeAt?.toISOString() ?? null,
        });
        return {
          kind: "window-closed",
          status: parked.status,
          resumeAt: parked.resumeAt,
        };
      }

      // E-315 — no first-pass leads left, but automatic retries are booked.
      // Stay 'running' and idle rather than parking: a SINGLE run parked as
      // 'paused' would need a human to resume it. The retry times already sit
      // inside the window, and wakeDueRetries re-enters here once it reopens.
      const nextAt = await nextScheduledRetry(campaignId);
      if (nextAt) return { kind: "waiting-retry", nextAt };
    }

    const provider = (cmp[0].provider || "bolna").toLowerCase();

    // A campaign mid-retry ("Retry failed leads") carries recall:true in its
    // region_filter. For these, bypass the once-per-day idempotency guard so the
    // deliberate second dial actually goes through even on the same day the lead
    // first failed. Normal campaigns and cron follow-ups keep the guard.
    const isRecall =
      (cmp[0].region_filter as { recall?: boolean } | null)?.recall === true;
    // (E-315 automatic retries bypass it too — see bypassIdempotency below.)

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
          // E-315 — unreached leads with a retry still booked mean the
          // campaign is NOT done; it idles until wakeDueRetries finds one due.
          const nextAt = await nextScheduledRetry(campaignId);
          if (nextAt) return { kind: "waiting-retry", nextAt };
          await finalizeCampaign(campaignId, "completed");
          return { kind: "no-pending", finalized: true };
        }
        return { kind: "no-pending", finalized: false };
      }

      const lead = await db
        .select({
          id: dealerLeads.id,
          phone: dealerLeads.phone,
          lead_status: dealerLeads.lead_status,
          ai_recall_status: dealerLeads.ai_recall_status,
          // Projected here rather than checked inside isAiDialable(), which is
          // shared with the NeoDove human push. One correlated EXISTS on an
          // indexed column, on a single-row primary-key lookup, once per dial —
          // and dials are 5s apart.
          ai_connected: sql<boolean>`EXISTS (
            SELECT 1 FROM ai_call_logs acl
             WHERE acl.lead_id = ${dealerLeads.id} AND ${AI_CONNECTED_CALL_SQL}
          )`,
        })
        .from(dealerLeads)
        .where(eq(dealerLeads.id, claimed.leadId))
        .limit(1);

      if (lead.length === 0 || !lead[0].phone) {
        // Mark the claimed row skipped with a clear outcome and continue
        // to the next pending row. Bump counters so the campaign card
        // reflects the progress. Log per-row so operators can audit
        // which leads were skipped in a bad batch.
        //
        // 'skipped', not 'failed': no call was attempted, so this lead must
        // not count as a failed call or towards "Calls attempted".
        console.warn("[advanceCampaign] skipping no-phone lead", {
          campaignId,
          leadId: claimed.leadId,
          campaignLeadId: claimed.campaignLeadId,
        });
        await db
          .update(dialerCampaignLeads)
          .set({
            status: "skipped",
            completed_at: new Date(),
            call_outcome: "no_phone",
          })
          .where(eq(dialerCampaignLeads.id, claimed.campaignLeadId));
        // Counters are derived from the rows — see syncCampaignCounters.
        await syncCampaignCounters(campaignId);
        continue;
      }

      // BRD §0.2 — defensive exclusion filter. A lead can enter an active
      // sales state after the campaign was queued; skip it the same way as a
      // no-phone lead so the campaign keeps advancing and the dialer never
      // re-contacts a lead Inside Sales / ASM are working.
      if (!isAiDialable(lead[0])) {
        console.warn("[advanceCampaign] skipping lead now in an active sales state", {
          campaignId,
          leadId: claimed.leadId,
          leadStatus: lead[0].lead_status,
        });
        await db
          .update(dialerCampaignLeads)
          .set({
            status: "skipped",
            completed_at: new Date(),
            call_outcome: "ineligible_active_lead",
          })
          .where(eq(dialerCampaignLeads.id, claimed.campaignLeadId));
        await syncCampaignCounters(campaignId);
        continue;
      }

      // The AI-connected hard block, re-checked at dial time.
      //
      // A separate branch rather than a condition folded into isAiDialable():
      // that function is shared with the NeoDove HUMAN push, which must keep
      // receiving these leads (see the header in exclusionFilter.ts). Keeping
      // them apart also keeps the two reasons attributable — the call_outcome
      // says which rule refused the lead.
      //
      // Reachable in normal operation: a concurrent campaign, or a manual call,
      // can connect with this lead after it was enrolled here.
      if (lead[0].ai_connected) {
        console.warn("[advanceCampaign] skipping lead the AI has already spoken to", {
          campaignId,
          leadId: claimed.leadId,
        });
        await db
          .update(dialerCampaignLeads)
          .set({
            status: "skipped",
            completed_at: new Date(),
            call_outcome: "ineligible_ai_connected",
          })
          .where(eq(dialerCampaignLeads.id, claimed.campaignLeadId));
        await syncCampaignCounters(campaignId);
        continue;
      }

      // E-315 — a retry is a deliberate same-day redial; without the bypass the
      // 25h duplicate guard answers success-with-no-call-id and the row sits in
      // 'calling' until the watchdog fails it.
      const bypassIdempotency = isRecall || claimed.attemptCount > 1;

      // Place the call via the right provider.
      let trigResult: { success: boolean; call_id?: string; error?: string };
      try {
        if (provider === "elevenlabs") {
          trigResult = (await triggerElevenLabsCall({
            phone: lead[0].phone,
            leadId: lead[0].id,
            bypassIdempotency,
          })) as typeof trigResult;
        } else {
          trigResult = (await triggerBolnaCall({
            phone: lead[0].phone,
            leadId: lead[0].id,
            bypassIdempotency,
          })) as typeof trigResult;
        }
      } catch (err) {
        // Trigger threw — mark this row failed and CONTINUE to the next
        // pending lead. Previously we returned an error here, which left
        // the caller (webhook/poll) thinking the advance failed and
        // stalled the whole campaign on a single provider exception.
        const exReason = (
          err instanceof Error ? err.message : String(err)
        ).slice(0, 160);
        console.error(
          "[advanceCampaign] trigger threw, skipping lead",
          {
            campaignId,
            leadId: lead[0].id,
            campaignLeadId: claimed.campaignLeadId,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        await recordAttemptOutcome({
          campaignLeadId: claimed.campaignLeadId,
          status: classifyCallEnd({ triggerError: exReason }).status,
          outcome: `trigger_exception: ${exReason}`,
        });
        await syncCampaignCounters(campaignId);
        continue;
      }

      if (!trigResult.success) {
        // Provider rejected the call (missing/invalid config, rate limit, bad
        // number, etc.). Capture WHY: previously this stored a bare
        // "trigger_failed" and discarded trigResult.error, which made
        // "works on localhost, fails on sandbox" impossible to diagnose from
        // the UI (the usual cause is a missing/wrong provider env var on the
        // box — e.g. ELEVENLABS_AGENT_PHONE_NUMBER_ID or ELEVENLABS_PHONE_
        // PROVIDER). Log it AND persist a short reason on the row so the
        // failure explains itself in production.
        const reason = (trigResult.error || "unknown").slice(0, 160);
        console.error("[advanceCampaign] provider trigger failed", {
          campaignId,
          leadId: lead[0].id,
          provider,
          error: trigResult.error,
        });
        // Over a SIP trunk the provider reports a busy / unanswered / declined
        // line HERE, synchronously, as the INVITE's SIP status (486 / 480 /
        // 603) — so this is where most "the dealer didn't pick up" outcomes
        // are born. Classify it instead of filing every one as failed.
        await recordAttemptOutcome({
          campaignLeadId: claimed.campaignLeadId,
          status: classifyCallEnd({ triggerError: reason }).status,
          outcome: `trigger_failed: ${reason}`,
        });
        await syncCampaignCounters(campaignId);
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

      // E-228 — stamp real activity. The stall watchdog measures inactivity
      // from COALESCE(last_advanced_at, started_at); without this a campaign
      // resumed the morning after an overnight pause still carries yesterday's
      // started_at, so it reads as hours-stale and is force-stopped before it
      // places its first call of the day — every day. Best-effort: a failed
      // stamp must not lose a call that is already live.
      try {
        await db
          .update(dialerCampaigns)
          .set({ last_advanced_at: new Date() })
          .where(eq(dialerCampaigns.id, campaignId));
      } catch (err) {
        console.error("[advanceCampaign] last_advanced_at stamp failed:", err);
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
