// Shared post-call pipeline for ElevenLabs calls. See finalizeCall.ts in the
// Bolna folder for the design rationale — this is the symmetric version.

import { analyzeTranscript } from "@/lib/ai/analysis";
import { db } from "@/lib/db";
import { aiCallLogs, dealerLeads, dialerCampaigns } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { updateLeadAfterCall } from "../storage/leadStore";
import { completeCampaignLead } from "@/lib/queue/campaignTracker";
import { advanceCampaign } from "@/lib/queue/advanceCampaign";
import { scheduleElevenLabsCall } from "@/lib/queue/scheduler";
import {
  appendSalesCallLog,
  appendCallReview,
  callReviewSheetEnabled,
} from "@/lib/google/sheet";
import { resolveNextCallAt } from "@/lib/ai/analysis/postCallHelpers";
import { claimCallForProcessing } from "@/lib/ai/analysis/callClaim";
import { fetchAndPersistCallCost } from "@/lib/ai/storage/costStore";
import { writeAiCallTouchpoint } from "@/lib/ai/storage/callTouchpoint";
import {
  rehostRecording,
  rehostElevenLabsRecording,
} from "@/lib/ai/storage/recordingStore";

export type ElevenLabsFinalizePayload = {
  conversationId: string;
  status: string;
  transcript: string | null;
  recordingUrl: string | null;
  duration: number | null;
  phone: string | null;
  leadId?: string;
  conversation?: unknown[];
  /**
   * When the call actually happened, from the provider's own clock.
   *
   * These exist because every date-bounded query on /operations/elevenlabs
   * buckets on `ended_at` (see cost-analytics-query.ts istDayBounds). Stamping
   * write time instead — which is what this pipeline did — files a webhook that
   * arrives at 00:05 IST against the wrong day, and a backfilled or retried
   * call against the wrong month entirely. The provider knows when the call
   * ended; we should not be guessing from when we got told.
   */
  startedAt?: Date | null;
  endedAt?: Date | null;
  /** ElevenLabs agent that handled the call. Present on the payload, never stored until now. */
  agentId?: string | null;
};

const IN_PROGRESS = new Set(["initiated", "ringing", "in-progress"]);
const ADVANCE_DELAY_MS = 5_000;

// Resolve a browser-playable recording URL for an ElevenLabs call. ElevenLabs
// doesn't hand back a hosted recording URL on the webhook/poll (unlike Bolna),
// so prefer an explicit URL if one ever appears, otherwise pull the audio bytes
// from the conversation /audio endpoint and re-host them. Returns "" if no
// recording could be produced.
async function resolveElevenLabsPlayableUrl(
  conversationId: string,
  recordingUrl: string | null,
): Promise<string> {
  if (recordingUrl) {
    return rehostRecording({
      provider: "elevenlabs",
      callId: conversationId,
      recordingUrl,
    });
  }
  return rehostElevenLabsRecording(conversationId);
}

export async function finalizeElevenLabsCall(
  payload: ElevenLabsFinalizePayload,
): Promise<void> {
  const {
    conversationId,
    status,
    transcript,
    recordingUrl,
    duration,
    phone,
    leadId: leadIdHint,
    conversation,
    startedAt,
    endedAt,
    agentId,
  } = payload;

  if (IN_PROGRESS.has(status)) {
    return;
  }

  if (conversationId) {
    const claimed = await claimCallForProcessing("elevenlabs", conversationId);
    if (!claimed) {
      console.log("[elevenlabs:finalize] already processed:", conversationId);
      return;
    }
  }

  if (!transcript) {
    console.log(
      "[elevenlabs:finalize] no transcript on terminal event, status:",
      status,
    );
    let leadForPhone:
      | {
          id: string;
          phone: string | null;
          shop_name: string | null;
          dealer_name: string | null;
        }
      | null
      | undefined = null;

    if (leadIdHint) {
      leadForPhone = await db.query.dealerLeads.findFirst({
        where: (l, { eq }) => eq(l.id, leadIdHint),
      });
    } else if (phone) {
      leadForPhone = await db.query.dealerLeads.findFirst({
        where: (l, { eq }) => eq(l.phone, phone),
      });
    }

    let campaignIdAfterComplete: string | null = null;

    // Logged FIRST, and unconditionally — outside the `if (leadForPhone)` this
    // used to sit inside. A call we cannot attribute to a dealer_lead is still
    // a call that was placed, billed and counted by the provider; dropping it
    // is how the dashboard came to show 0 calls against 738 real ones. Inbound
    // calls have no lead_id at all and their external_number arrives in local
    // format (08035315136) that will never match a stored +91 number, so this
    // branch is the *normal* path for them, not an edge case.
    await upsertAiCallLog({
      callId: conversationId,
      leadId: leadForPhone?.id ?? null,
      startedAt,
      endedAt,
      agentId,
      status: status || "failed",
      transcript: null,
      summary: null,
      recordingUrl,
      duration,
      phone: phone ?? leadForPhone?.phone ?? null,
      intentScore: null,
      intentReason: null,
      nextAction: null,
    });

    // Even failed calls (initiation_failure, busy, no-answer) accrue partial
    // cost on ElevenLabs. Best-effort fetch; backfill retries. Also moved out
    // of the lead check: costStore keys on call_id, which now always exists, so
    // an unattributed call still gets its cost — and the cost column is what
    // the Cost tile sums.
    await fetchAndPersistCallCost("elevenlabs", conversationId);

    if (leadForPhone) {
      // Record it in the CC team's vocabulary. See the Bolna twin for why this
      // sits after the log exists and before completeCampaignLead.
      await writeAiCallTouchpoint({
        leadId: leadForPhone.id,
        provider: "elevenlabs",
        callId: conversationId,
        transcript: null,
        providerStatus: status || "failed",
        durationSec: duration ?? null,
        recordingUrl,
      });

      const r = await completeCampaignLead({
        leadId: leadForPhone.id,
        success: false,
        bolnaCallId: conversationId || null,
        outcome: status || "no_transcript",
        intentScore: null,
      });
      campaignIdAfterComplete = r.campaignId;

      // "All calls" requirement: log no-conversation calls to the
      // Campaign_Call_Review sheet too. No transcript exists, so the Transcript
      // cell carries a short status note. Fire-and-forget — including the
      // campaign-name lookup and recording re-host — so it never blocks or
      // breaks finalization or campaign advancement. Values captured into consts
      // since `leadForPhone` is a `let` and loses its narrowing in the closure.
      const reviewUuid = conversationId ?? "—";
      const reviewCompany = leadForPhone.shop_name ?? "—";
      const reviewDealer = leadForPhone.dealer_name ?? "—";
      const reviewCampaignId = r.campaignId;
      const reviewStatus = status || "no_answer";
      void (async () => {
        let campaign = reviewCampaignId ?? "—";
        if (reviewCampaignId) {
          const c = await db
            .select({ name: dialerCampaigns.name })
            .from(dialerCampaigns)
            .where(eq(dialerCampaigns.id, reviewCampaignId))
            .limit(1);
          campaign = c[0]?.name ?? reviewCampaignId;
        }
        // E-250 — the Campaign_Call_Review sheet is retired by default. The
        // guard sits ABOVE the playable-URL resolve because that call pulls
        // the conversation audio from ElevenLabs and re-hosts it purely so the
        // sheet has a clickable link; with the sheet off it is wasted work.
        if (!callReviewSheetEnabled()) return;
        const playableUrl = await resolveElevenLabsPlayableUrl(
          conversationId,
          recordingUrl,
        );
        await appendCallReview({
          uuid: reviewUuid,
          campaign,
          companyName: reviewCompany,
          dealerName: reviewDealer,
          recordingUrl: playableUrl,
          transcript: `No conversation (${reviewStatus})`,
        });
      })().catch((err) =>
        console.error("[elevenlabs:finalize] call review log failed:", err),
      );
    }
    if (campaignIdAfterComplete) {
      await advanceCampaign(campaignIdAfterComplete, {
        preCallDelayMs: ADVANCE_DELAY_MS,
      });
    }
    return;
  }

  // Locate the dealer_leads row first — both the scored and the analysis-failed
  // paths need it. Prefer the hint, then phone.
  let lead:
    | {
        id: string;
        phone: string | null;
        follow_up_history: unknown;
        shop_name: string | null;
        dealer_name: string | null;
      }
    | null
    | undefined = null;
  if (leadIdHint) {
    lead = await db.query.dealerLeads.findFirst({
      where: (l, { eq }) => eq(l.id, leadIdHint),
    });
  } else if (phone) {
    lead = await db.query.dealerLeads.findFirst({
      where: (l, { eq }) => eq(l.phone, phone),
    });
  }

  if (!lead) {
    console.warn("[elevenlabs:finalize] no dealer_leads row for", {
      phone,
      leadIdHint,
    });
    // Log the call before giving up on attributing it. The transcript exists
    // and the provider has already billed for it; only the CRM linkage is
    // missing. Returning here without a write — which is what this did — meant
    // a real, paid-for conversation left no trace anywhere in the product.
    //
    // Analysis is deliberately skipped: scoring writes back to a dealer_lead,
    // and there is none. The row carries the transcript so the call can be
    // attributed by hand later, and re-finalizing after the lead exists will
    // upsert the score onto this same row.
    await upsertAiCallLog({
      callId: conversationId,
      leadId: null,
      startedAt,
      endedAt,
      agentId,
      status: status || "completed",
      transcript,
      summary: null,
      recordingUrl,
      duration,
      phone,
      intentScore: null,
      intentReason: null,
      nextAction: null,
      callStatus: "unattributed",
    });
    await fetchAndPersistCallCost("elevenlabs", conversationId);
    return;
  }

  const result = await analyzeTranscript(transcript);

  // No silent zeros: on analysis failure mark needs_review, KEEP any prior
  // score, and surface the call for human follow-up.
  if (result.status === "failed") {
    console.error(
      `[elevenlabs:finalize] analysis failed for lead ${lead.id}: ${result.reason}`,
    );
    const r = await markLeadNeedsReview({
      leadId: lead.id,
      followUpHistory: (lead.follow_up_history as unknown[]) || [],
      callId: conversationId,
      status,
      transcript,
      recordingUrl,
      duration,
      phone: phone ?? lead.phone,
      conversation: conversation ?? [],
      reason: result.reason,
      startedAt,
      endedAt,
      agentId,
    });
    if (r.campaignId) {
      await advanceCampaign(r.campaignId, { preCallDelayMs: ADVANCE_DELAY_MS });
    }
    return;
  }

  const analysis = result;
  const action = analysis.action;
  const hardNegative = analysis.hard_negative;

  // ── dropped_empty: line dropped before anything was captured. No band is
  // written; tag the call and let normal scheduling re-attempt it. ──
  if (analysis.band === null) {
    const history = (lead.follow_up_history as unknown[]) || [];
    const droppedEntry = {
      attempt: history.length + 1,
      called_at: new Date().toISOString(),
      outcome: "dropped_empty",
      call_status: "dropped_empty",
      transcript,
      conversation: conversation ?? [],
      signals: analysis.signals,
      scoring_version: analysis.scoring_version,
      provider: "elevenlabs",
    };
    await db
      .update(dealerLeads)
      .set({
        follow_up_history: [...history, droppedEntry],
        total_attempts: history.length + 1,
        call_status: "dropped_empty",
        provider: "elevenlabs",
      })
      .where(eq(dealerLeads.id, lead.id));

    await upsertAiCallLog({
      callId: conversationId,
      leadId: lead.id,
      startedAt,
      endedAt,
      agentId,
      status: status || "call-disconnected",
      transcript,
      summary: "dropped_empty — call cut off before anything was captured",
      recordingUrl,
      duration,
      phone: phone ?? lead.phone,
      transcriptTurns: conversation ?? null,
      intentScore: null,
      intentReason: null,
      nextAction: "auto_retry",
      scoringVersion: analysis.scoring_version,
      extractionVersion: analysis.extraction_version,
      calibrationSetHash: analysis.calibration_set_hash,
      signals: analysis.signals,
      scoreBreakdown: analysis.score_breakdown,
      band: null,
      callStatus: "dropped_empty",
      infoSignalsCount: 0,
    });

    await fetchAndPersistCallCost("elevenlabs", conversationId);

    // A transcript exists, so this is CONNECTED — Cold / Short Hang up.
    await writeAiCallTouchpoint({
      leadId: lead.id,
      provider: "elevenlabs",
      callId: conversationId,
      transcript,
      providerStatus: status || "completed",
      bandCallStatus: "dropped_empty",
      band: null,
      infoSignalsCount: 0,
      durationSec: duration ?? null,
      recordingUrl,
      summary: analysis.memory?.intent_summary ?? null,
    });

    // dropped_empty connected and produced a transcript — the line just dropped
    // before any qualifying info was captured. It is NOT a telephony failure, so
    // the campaign row is marked completed ("Done"), not failed. The Outcome
    // column still carries "dropped_empty" to preserve the call-quality nuance.
    // Mirrors the Bolna path (bolna_ai/finalizeCall.ts) — this branch was missed
    // when that one was fixed, so every ElevenLabs campaign kept producing red
    // "Failed" rows for calls that actually connected. See E-169 / E-239.
    const dr = await completeCampaignLead({
      leadId: lead.id,
      success: true,
      bolnaCallId: conversationId || null,
      outcome: "dropped_empty",
      intentScore: null,
    });
    if (dr.campaignId) {
      await advanceCampaign(dr.campaignId, { preCallDelayMs: ADVANCE_DELAY_MS });
    }
    return;
  }

  const nextCallAt = resolveNextCallAt(
    { callback_time: analysis.callback_time, intent_score: analysis.intent_score },
    transcript,
    action,
  );

  const updatedLead = updateLeadAfterCall(
    {
      ...lead,
      follow_up_history: (lead.follow_up_history as unknown[]) || [],
    },
    {
      transcript,
      outcome: analysis.outcome,
      nextCallAt,
      conversation: conversation ?? [],
      memory: analysis.memory,
      provider: "elevenlabs",
      intentScore: analysis.intent_score,
      band: analysis.band,
      callStatus: analysis.call_status,
      infoSignalsCount: analysis.info_signals_count,
      signals: analysis.signals,
      scoreBreakdown: analysis.score_breakdown,
      scoringVersion: analysis.scoring_version,
      extractionVersion: analysis.extraction_version,
      calibrationSetHash: analysis.calibration_set_hash,
      hardNegative,
    },
  );

  await db
    .update(dealerLeads)
    .set({
      follow_up_history: updatedLead.follow_up_history,
      total_attempts: updatedLead.total_attempts,
      final_intent_score: updatedLead.final_intent_score,
      current_status: updatedLead.current_status,
      interest_level: updatedLead.interest_level,
      call_status: updatedLead.call_status,
      info_signals_count: updatedLead.info_signals_count,
      intent_band: updatedLead.intent_band,
      memory: updatedLead.memory,
      next_call_at: nextCallAt,
      provider: "elevenlabs",
    })
    .where(eq(dealerLeads.id, lead.id));

  const summary = analysis.memory?.intent_summary
    ? `${analysis.band} — ${analysis.memory.intent_summary}`
    : `${analysis.band} — ${analysis.info_signals_count}/5 signals disclosed`;

  await upsertAiCallLog({
    callId: conversationId,
    leadId: lead.id,
    startedAt,
    endedAt,
    agentId,
    status: status || "completed",
    transcript,
    summary,
    recordingUrl,
    duration,
    phone: phone ?? lead.phone,
    transcriptTurns: conversation ?? null,
    intentScore: analysis.intent_score,
    intentReason: analysis.memory?.intent_summary ?? null,
    nextAction: action ?? null,
    scoringVersion: analysis.scoring_version,
    extractionVersion: analysis.extraction_version,
    calibrationSetHash: analysis.calibration_set_hash,
    signals: analysis.signals,
    scoreBreakdown: analysis.score_breakdown,
    band: analysis.band,
    callStatus: analysis.call_status,
    infoSignalsCount: analysis.info_signals_count,
  });

  // Capture per-call cost from ElevenLabs /v1/convai/conversations/{id}.
  // Best-effort: backfill cron is the recovery path on race or 5xx.
  await fetchAndPersistCallCost("elevenlabs", conversationId);

  // The scored path. The band rides on external_tag rather than deciding the L2
  // bucket — an AI call cannot reach the sheet's Hot bucket. See aiDisposition.ts.
  await writeAiCallTouchpoint({
    leadId: lead.id,
    provider: "elevenlabs",
    callId: conversationId,
    transcript,
    providerStatus: status || "completed",
    band: analysis.band,
    bandCallStatus: analysis.call_status,
    infoSignalsCount: analysis.info_signals_count,
    disqualifier: analysis.signals?.disqualifier ?? null,
    callbackAgreed: analysis.signals?.callback_agreed === "yes",
    relevantDealer: analysis.signals?.relevant_dealer === "yes",
    pitchHeard: analysis.signals?.pitch_heard === "yes",
    durationSec: duration ?? null,
    recordingUrl,
    summary: analysis.memory?.intent_summary ?? null,
    nextCallAt: nextCallAt ?? null,
  });

  const completeR = await completeCampaignLead({
    leadId: lead.id,
    success: true,
    bolnaCallId: conversationId || null,
    outcome: analysis.outcome,
    intentScore: analysis.intent_score,
  });

  if (action === "schedule_call" && nextCallAt && phone) {
    const messageId = await scheduleElevenLabsCall({
      phone,
      leadId: lead.id,
      runAt: nextCallAt,
    });
    if (!messageId) {
      console.warn(
        `[elevenlabs:finalize] scheduleElevenLabsCall returned null for ${lead.id} — call-scheduler cron is the recovery path`,
      );
    }
  }
  // Qualified (action push_to_crm) already lands current_status="qualified" via
  // updateLeadAfterCall above.

  appendSalesCallLog({
    leadId: lead.id,
    timestamp: new Date(),
    direction: "outbound",
    toNumber: phone ?? "",
    fromNumber: process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID ?? "—",
    transcript,
    summary,
    convId: conversationId ?? "—",
  }).catch((err) =>
    console.error("[elevenlabs:finalize] sheet log failed:", err),
  );

  // Mirror this connected call into the Campaign_Call_Review sheet so the
  // reviewers can leave feedback. Fire-and-forget — including the campaign-name
  // lookup and recording re-host — so it never blocks or breaks finalization or
  // campaign advance. Values captured into consts because `lead` is a `let` and
  // loses its non-null narrowing inside the closure below.
  const reviewUuid = conversationId ?? "—";
  const reviewCompany = lead.shop_name ?? "—";
  const reviewDealer = lead.dealer_name ?? "—";
  const reviewCampaignId = completeR.campaignId;
  void (async () => {
    let campaign = reviewCampaignId ?? "—";
    if (reviewCampaignId) {
      const c = await db
        .select({ name: dialerCampaigns.name })
        .from(dialerCampaigns)
        .where(eq(dialerCampaigns.id, reviewCampaignId))
        .limit(1);
      campaign = c[0]?.name ?? reviewCampaignId;
    }
    // E-250 — see the note on the sibling closure above.
    if (!callReviewSheetEnabled()) return;
    const playableUrl = await resolveElevenLabsPlayableUrl(
      conversationId,
      recordingUrl,
    );
    await appendCallReview({
      uuid: reviewUuid,
      campaign,
      companyName: reviewCompany,
      dealerName: reviewDealer,
      recordingUrl: playableUrl,
      transcript,
    });
  })().catch((err) =>
    console.error("[elevenlabs:finalize] call review log failed:", err),
  );

  if (completeR.campaignId) {
    await advanceCampaign(completeR.campaignId, {
      preCallDelayMs: ADVANCE_DELAY_MS,
    });
  }
}

/**
 * E-267 — persist the provider's turn array, timings and all.
 *
 * A SEPARATE RAW STATEMENT, not a column on the drizzle model, and that is a
 * blast-radius decision rather than a stylistic one. `aiCallLogs` has 21 call
 * sites including three bare `db.insert()` on this very path; because drizzle
 * names every column of a mirrored table in its generated SQL, adding
 * transcript_turns to the model would make ALL of them fail with `column
 * "transcript_turns" does not exist` on any database where E-267 has not been
 * applied. There is no migration auto-runner here and the per-environment ticks
 * are known to drift, so that trades one dark metric for the entire AI
 * call-logging pipeline. Written this way, an unapplied E-267 costs exactly the
 * feature that needs it. Same rule as E-250/E-242/E-224/E-236.
 *
 * Stores the array VERBATIM rather than reshaping it. The whole point is to
 * stop discarding fields the provider sends, and a mapper that picked
 * {role, message, time} would lose the next field they add exactly the way the
 * stringifier lost this one. An empty array stores NULL, so "no turns" and "not
 * captured" stay distinguishable.
 *
 * Logs whether timings actually arrived. `time_in_call_secs` is optional in the
 * provider's schema and had never been read by this codebase when E-267 was
 * written, so this line is how the first live call answers that — rather than
 * someone noticing a permanently-empty metric weeks later.
 *
 * Best-effort, like every other write on this path: a failure here must not
 * take down call finalization.
 */
async function persistTranscriptTurns(
  callId: string,
  turns: unknown[] | null | undefined,
): Promise<void> {
  if (!callId || !Array.isArray(turns) || turns.length === 0) return;

  const timed = turns.filter(
    (t) =>
      t !== null &&
      typeof t === "object" &&
      typeof (t as { time_in_call_secs?: unknown }).time_in_call_secs === "number",
  ).length;

  try {
    await db.execute(
      sql`UPDATE ai_call_logs
             SET transcript_turns = ${JSON.stringify(turns)}::jsonb
           WHERE call_id = ${callId}`,
    );
    console.log(
      `[elevenlabs:finalize] stored ${turns.length} turn(s), ${timed} with timings`,
    );
  } catch (err) {
    // undefined_column means E-267 is unapplied on this database. Say so once,
    // plainly, instead of emitting a stack trace that reads like a real fault.
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "42703") {
      console.warn(
        "[elevenlabs:finalize] transcript_turns not stored — apply drizzle/E-267_ai_call_logs_transcript_turns.sql",
      );
      return;
    }
    console.error("[elevenlabs:finalize] transcript_turns write failed:", err);
  }
}

async function upsertAiCallLog(opts: {
  callId: string;
  /**
   * Null when no dealer_leads row matched.
   *
   * It used to be impossible to get here without a lead, because every caller
   * returned early instead — which is how 738 August calls became zero rows.
   * `lead_id` is nullable in the database; an unattributed call is a real call
   * and belongs in the log.
   */
  leadId: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
  agentId?: string | null;
  status: string;
  transcript: string | null;
  summary: string | null;
  recordingUrl: string | null;
  duration: number | null;
  phone: string | null;
  intentScore: number | null;
  intentReason: string | null;
  nextAction: string | null;
  scoringVersion?: string | null;
  // E-250 — which PROMPT read the transcript, alongside which band rule scored
  // it. The hash is required because the calibration set now lives in the DB
  // and changes without a deploy, so EXTRACTION_VERSION alone stops identifying
  // the prompt that produced these signals.
  extractionVersion?: string | null;
  calibrationSetHash?: string | null;
  signals?: unknown;
  scoreBreakdown?: unknown;
  band?: string | null;
  callStatus?: string | null;
  infoSignalsCount?: number | null;
  // E-267 — the provider's turn array VERBATIM. `transcript` above is this same
  // content flattened to "<speaker>: <message>" lines, a step that discards each
  // turn's time_in_call_secs. The array already travelled this far as the
  // payload's `conversation`; until E-267 it was dropped here.
  transcriptTurns?: unknown[] | null;
}): Promise<void> {
  try {
    const now = new Date();
    // Prefer the provider's clock; fall back to write time only when the
    // payload carried no timestamp at all.
    const endedAt = opts.endedAt ?? now;
    const id = opts.callId ? `AICALL_${opts.callId}` : `AICALL_${Date.now()}`;

    // Fields that always reflect the latest word from the provider. A
    // redelivery carries the same or better information, so overwriting is
    // correct for these.
    const latest = {
      status: opts.status,
      transcript: opts.transcript,
      summary: opts.summary,
      recording_url: opts.recordingUrl,
      call_duration: opts.duration,
      intent_score: opts.intentScore,
      intent_reason: opts.intentReason,
      next_action: opts.nextAction,
      scoring_version: opts.scoringVersion ?? null,
      extraction_version: opts.extractionVersion ?? null,
      calibration_set_hash: opts.calibrationSetHash ?? null,
      signals: opts.signals ?? null,
      score_breakdown: opts.scoreBreakdown ?? null,
      band: opts.band ?? null,
      call_status: opts.callStatus ?? null,
      info_signals_count: opts.infoSignalsCount ?? null,
    };

    // A REAL upsert against ai_call_logs_call_id_unique, not a SELECT then an
    // INSERT. The old shape had a race between the two statements that the
    // unique constraint turned into a 23505 — which the catch below swallowed,
    // silently dropping the second write. ElevenLabs redelivers, and two pm2
    // workers can finalize the same call when the Redis claim degrades to its
    // process-local fallback, so that race was reachable in production.
    //
    // The conditional spreads are the no-clobber rule: a field the provider did
    // not send this time must not overwrite a good value stored last time.
    await db
      .insert(aiCallLogs)
      .values({
        id,
        call_id: opts.callId || id,
        lead_id: opts.leadId,
        provider: "elevenlabs",
        phone_number: opts.phone,
        started_at: opts.startedAt ?? null,
        ended_at: endedAt,
        agent_id: opts.agentId ?? null,
        ...latest,
      })
      .onConflictDoUpdate({
        target: aiCallLogs.call_id,
        set: {
          ...latest,
          ended_at: endedAt,
          updated_at: now,
          ...(opts.startedAt ? { started_at: opts.startedAt } : {}),
          ...(opts.agentId ? { agent_id: opts.agentId } : {}),
          ...(opts.leadId ? { lead_id: opts.leadId } : {}),
          ...(opts.phone ? { phone_number: opts.phone } : {}),
        },
      });

    // E-267 — preserved from origin/main. The branch refactor replaced the
    // read-then-update body that used to carry this call, so re-attach it to
    // the upsert path or the provider's verbatim turn array is never stored.
    await persistTranscriptTurns(opts.callId || id, opts.transcriptTurns);
  } catch (err) {
    console.error("[elevenlabs:finalize] ai_call_logs upsert failed:", err);
  }
}

// Analysis-failure path (symmetric with the Bolna pipeline): record the call as
// needs_review WITHOUT scoring it, leave final_intent_score untouched, and still
// complete the campaign lead so the dialer advances.
async function markLeadNeedsReview(opts: {
  leadId: string;
  followUpHistory: unknown[];
  callId: string;
  status: string;
  transcript: string | null;
  recordingUrl: string | null;
  duration: number | null;
  phone: string | null;
  conversation: unknown[];
  reason: string;
  startedAt?: Date | null;
  endedAt?: Date | null;
  agentId?: string | null;
}): Promise<{ campaignId: string | null }> {
  const history = opts.followUpHistory || [];
  const newEntry = {
    attempt: history.length + 1,
    called_at: new Date().toISOString(),
    outcome: "needs_review",
    analysis_failed: true,
    reason: opts.reason,
    transcript: opts.transcript || "",
    conversation: opts.conversation || [],
    provider: "elevenlabs",
  };

  try {
    await db
      .update(dealerLeads)
      .set({
        follow_up_history: [...history, newEntry],
        total_attempts: history.length + 1,
        current_status: "needs_review",
        provider: "elevenlabs",
      })
      .where(eq(dealerLeads.id, opts.leadId));
  } catch (err) {
    console.error("[elevenlabs:finalize] needs_review update failed:", err);
  }

  await upsertAiCallLog({
    callId: opts.callId,
    leadId: opts.leadId,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    agentId: opts.agentId,
    status: "needs_review",
    transcript: opts.transcript,
    summary: `analysis_failed — ${opts.reason}`,
    recordingUrl: opts.recordingUrl,
    duration: opts.duration,
    phone: opts.phone,
    intentScore: null,
    intentReason: opts.reason,
    nextAction: null,
    // The analysis failed, so the turns are the ONLY structured record of this
    // call. Storing them is what lets it be re-read later without re-dialling.
    transcriptTurns: opts.conversation ?? null,
  });

  await fetchAndPersistCallCost("elevenlabs", opts.callId);

  // Connected with a NULL L3: the dealer WAS reached, but the failure is ours.
  // See the Bolna twin — that null is the extraction-failure measurement.
  await writeAiCallTouchpoint({
    leadId: opts.leadId,
    provider: "elevenlabs",
    callId: opts.callId,
    transcript: opts.transcript,
    providerStatus: opts.status || "needs_review",
    analysisFailed: true,
    durationSec: opts.duration,
    recordingUrl: opts.recordingUrl,
  });

  const r = await completeCampaignLead({
    leadId: opts.leadId,
    success: true,
    bolnaCallId: opts.callId || null,
    outcome: "needs_review",
    intentScore: null,
  });
  return { campaignId: r.campaignId };
}
