// GET /api/ai-dialer/campaigns/[id]/leads/[leadId]/transcript
//
// Powers the slide-in transcript drawer on the Campaign Detail page. Returns
// everything the drawer needs in one round-trip:
//   - lead identity (name, phone, location)
//   - campaign-lead status (pending / calling / completed / failed)
//   - latest ai_call_logs row (transcript, summary, recording, duration)
//   - per-call analysis (the 6 sub-scores from the analyzer)
//
// Source of truth for the transcript itself is ai_call_logs (one row per
// placed call). The 6-dimension analysis lives inside
// dealer_leads.follow_up_history[*].analysis — picked as the last entry,
// which corresponds to the latest call. follow_up_history entries don't
// carry a call_id, so "last entry" is the best we can do.

import { db } from "@/lib/db";
import {
  aiCallLogs,
  dealerLeads,
  dialerCampaignLeads,
  dialerCampaigns,
} from "@/lib/db/schema";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { INTENT_THRESHOLDS } from "@/lib/ai/scoring";

// Intent score at/above which the dialer considers a lead "qualified" — the
// single central threshold (INTENT_THRESHOLDS), shared with routing/status. The
// first attempt to reach it is treated as the converting attempt.
const QUALIFIED_INTENT = INTENT_THRESHOLDS.QUALIFIED;

type SubScores = {
  next_step_commitment: number;
  urgency_signals: number;
  product_curiosity: number;
  need_acknowledgment: number;
  objection_quality: number;
  engagement_depth: number;
};

// The truthful per-point breakdown produced by the deterministic scorer.
// Contributions sum to the intent score. Absent on pre-refactor rows.
type ScoreBreakdownItem = {
  signal: string;
  label: string;
  contribution: number;
  evidence: string;
};

// Shape of the analyzer's `memory` jsonb on dealer_leads. Only intent_summary
// is required for the drawer's Summary fallback; the rest is informational.
type LeadMemory = {
  intent_summary?: string | null;
  requirement?: string | null;
  product_interest?: string | null;
  quantity?: string | null;
  followup_reason?: string | null;
};

function formatOutcomeLabel(o: string): string {
  return o
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

// Always-on summary: prefer the analyzer's per-call summary if it exists,
// then fall back through the lead's rollup fields, and finally synthesize
// a short line from whatever signals we have (outcome + intent + standout
// sub-scores). Reviewers asked for a one-line "what happened" on every
// completed call — this guarantees that line is never blank.
function buildSummary(opts: {
  callSummary: string | null;
  overallSummary: string | null;
  memory: LeadMemory | null;
  outcome: string | null;
  intentScore: number | null;
  analysis: SubScores | null;
  hasTranscript: boolean;
}): string | null {
  if (opts.callSummary && opts.callSummary.trim()) return opts.callSummary;
  if (opts.overallSummary && opts.overallSummary.trim())
    return opts.overallSummary;
  const memSummary = opts.memory?.intent_summary?.trim();
  if (memSummary) {
    return opts.outcome
      ? `${formatOutcomeLabel(opts.outcome)} — ${memSummary}`
      : memSummary;
  }
  // Last-resort synthesized summary. Only emit when we have at least one
  // signal — otherwise return null so the drawer hides the section.
  const parts: string[] = [];
  if (opts.outcome) parts.push(formatOutcomeLabel(opts.outcome));
  if (opts.intentScore != null) parts.push(`intent score ${opts.intentScore}/100`);
  if (opts.analysis) {
    const standout: string[] = [];
    if (opts.analysis.urgency_signals >= 7) standout.push("high urgency");
    if (opts.analysis.next_step_commitment >= 7)
      standout.push("committed to a next step");
    if (opts.analysis.product_curiosity >= 7)
      standout.push("curious about the product");
    if (opts.analysis.need_acknowledgment >= 7)
      standout.push("acknowledged a need");
    if (opts.analysis.objection_quality >= 7)
      standout.push("voiced specific objections");
    if (opts.analysis.engagement_depth >= 7)
      standout.push("engaged throughout");
    if (standout.length) parts.push(`signals: ${standout.join(", ")}`);
  }
  if (parts.length === 0) {
    if (opts.hasTranscript)
      return "Call completed — see Transcription tab for the full conversation.";
    return null;
  }
  return parts.join(" · ");
}

type LastHistoryEntry = {
  analysis: SubScores | null;
  scoreBreakdown: ScoreBreakdownItem[] | null;
  scoringVersion: string | null;
  transcript: string | null;
  conversation: unknown[] | null;
  calledAt: string | null;
  outcome: string | null;
  provider: string | null;
};

function readLastHistory(history: unknown): LastHistoryEntry {
  if (!Array.isArray(history) || history.length === 0) {
    return {
      analysis: null,
      scoreBreakdown: null,
      scoringVersion: null,
      transcript: null,
      conversation: null,
      calledAt: null,
      outcome: null,
      provider: null,
    };
  }
  const last = history[history.length - 1] as {
    analysis?: unknown;
    score_breakdown?: unknown;
    scoring_version?: unknown;
    transcript?: string;
    dealer_said?: string;
    conversation?: unknown[];
    called_at?: string;
    outcome?: string;
    provider?: string;
  };
  const a = last?.analysis as Partial<SubScores> | undefined;
  const analysis: SubScores | null =
    a && typeof a === "object"
      ? {
          next_step_commitment: Number(a.next_step_commitment ?? 0),
          urgency_signals: Number(a.urgency_signals ?? 0),
          product_curiosity: Number(a.product_curiosity ?? 0),
          need_acknowledgment: Number(a.need_acknowledgment ?? 0),
          objection_quality: Number(a.objection_quality ?? 0),
          engagement_depth: Number(a.engagement_depth ?? 0),
        }
      : null;
  const scoreBreakdown = Array.isArray(last?.score_breakdown)
    ? (last.score_breakdown as ScoreBreakdownItem[])
    : null;
  return {
    analysis,
    scoreBreakdown,
    scoringVersion:
      typeof last?.scoring_version === "string" ? last.scoring_version : null,
    transcript: last?.transcript || last?.dealer_said || null,
    conversation: Array.isArray(last?.conversation) ? last.conversation : null,
    calledAt: last?.called_at ?? null,
    outcome: last?.outcome ?? null,
    provider: last?.provider ?? null,
  };
}

export const GET = withErrorHandler(
  async (
    _req: Request,
    ctx: { params: Promise<{ id: string; leadId: string }> },
  ) => {
    const { id: campaignId, leadId } = await ctx.params;
    if (!campaignId || !leadId) {
      return errorResponse("Campaign id and lead id required", 400);
    }

    // Pull campaign-lead row + lead identity in one query.
    const campaignLead = await db
      .select({
        status: dialerCampaignLeads.status,
        callOutcome: dialerCampaignLeads.call_outcome,
        intentScore: dialerCampaignLeads.intent_score,
        bolnaCallId: dialerCampaignLeads.bolna_call_id,
        startedAt: dialerCampaignLeads.started_at,
        completedAt: dialerCampaignLeads.completed_at,
        shopName: dealerLeads.shop_name,
        dealerName: dealerLeads.dealer_name,
        phone: dealerLeads.phone,
        city: dealerLeads.city,
        state: dealerLeads.state,
        followUpHistory: dealerLeads.follow_up_history,
        finalIntentScore: dealerLeads.final_intent_score,
        overallSummary: dealerLeads.overall_summary,
        memory: dealerLeads.memory,
      })
      .from(dialerCampaignLeads)
      .leftJoin(dealerLeads, eq(dealerLeads.id, dialerCampaignLeads.lead_id))
      .where(
        and(
          eq(dialerCampaignLeads.campaign_id, campaignId),
          eq(dialerCampaignLeads.lead_id, leadId),
        ),
      )
      .limit(1);

    if (campaignLead.length === 0) {
      return errorResponse("Lead not found in this campaign", 404);
    }

    const cl = campaignLead[0];

    // Latest ai_call_logs row for this lead — the transcript belongs to the
    // most recent attempt regardless of which call_id ended up on the
    // campaign-lead row (some failure paths don't backfill bolna_call_id).
    const calls = await db
      .select({
        callId: aiCallLogs.call_id,
        transcript: aiCallLogs.transcript,
        summary: aiCallLogs.summary,
        recordingUrl: aiCallLogs.recording_url,
        callDuration: aiCallLogs.call_duration,
        intentReason: aiCallLogs.intent_reason,
        intentScore: aiCallLogs.intent_score,
        status: aiCallLogs.status,
        nextAction: aiCallLogs.next_action,
        createdAt: aiCallLogs.created_at,
        // Raw extracted signals — drives the deep-mode correction dropdowns so a
        // reviewer can flip an over-read level (e.g. curiosity strong → none).
        signals: aiCallLogs.signals,
      })
      .from(aiCallLogs)
      .where(eq(aiCallLogs.lead_id, leadId))
      .orderBy(desc(aiCallLogs.created_at))
      .limit(1);

    const latest = calls[0] ?? null;
    const lastHistory = readLastHistory(cl.followUpHistory);

    // Cross-campaign attempt timeline for this lead. Each dialer_campaign_leads
    // row is one attempt; recall campaigns re-enrol the same lead_id, so
    // ordering every row (across original + recalls) by campaign start gives the
    // full journey. The converting attempt is the first to reach QUALIFIED_INTENT.
    const attemptRows = await db
      .select({
        campaignId: dialerCampaignLeads.campaign_id,
        campaignName: dialerCampaigns.name,
        regionFilter: dialerCampaigns.region_filter,
        campaignStartedAt: dialerCampaigns.started_at,
        status: dialerCampaignLeads.status,
        callOutcome: dialerCampaignLeads.call_outcome,
        intentScore: dialerCampaignLeads.intent_score,
        startedAt: dialerCampaignLeads.started_at,
        completedAt: dialerCampaignLeads.completed_at,
        bolnaCallId: dialerCampaignLeads.bolna_call_id,
      })
      .from(dialerCampaignLeads)
      .leftJoin(
        dialerCampaigns,
        eq(dialerCampaigns.id, dialerCampaignLeads.campaign_id),
      )
      .where(eq(dialerCampaignLeads.lead_id, leadId))
      .orderBy(
        asc(dialerCampaigns.started_at),
        asc(dialerCampaignLeads.created_at),
      );

    // Per-attempt recording: each attempt's bolna_call_id (the provider call id
    // for BOTH Bolna and ElevenLabs — the column doubles for both, see
    // elevenlabs/webhookHandler.ts) maps 1:1 to ai_call_logs.call_id. Resolve
    // them in one extra query rather than joining into attemptRows above, which
    // would risk duplicating rows and corrupting the i+1 attempt ordinal.
    const callIds = attemptRows
      .map((a) => a.bolnaCallId)
      .filter((c): c is string => !!c);
    const recordingByCall = new Map<string, string | null>();
    if (callIds.length > 0) {
      const recRows = await db
        .select({
          callId: aiCallLogs.call_id,
          recordingUrl: aiCallLogs.recording_url,
        })
        .from(aiCallLogs)
        .where(inArray(aiCallLogs.call_id, callIds));
      for (const r of recRows) recordingByCall.set(r.callId, r.recordingUrl);
    }

    const attempts = attemptRows.map((a, i) => {
      const intentScore = a.intentScore ?? null;
      const isRecall =
        a.regionFilter && typeof a.regionFilter === "object"
          ? (a.regionFilter as { recall?: unknown }).recall === true
          : false;
      const callId = a.bolnaCallId ?? null;
      const stored = callId ? recordingByCall.get(callId) ?? null : null;
      // Stored URL when present; else the self-healing proxy (re-hosts + backfills
      // ElevenLabs audio on first hit, 302s to Bolna's URL); else null — a
      // no-answer/failed attempt with no call id simply has no recording.
      const recordingUrl = stored
        ? stored
        : callId
          ? `/api/ai-dialer/recording/${encodeURIComponent(callId)}`
          : null;
      return {
        attempt: i + 1,
        campaignId: a.campaignId,
        campaignName: a.campaignName ?? null,
        isRecall,
        status: a.status,
        callOutcome: a.callOutcome,
        intentScore,
        startedAt: a.startedAt ?? a.campaignStartedAt ?? null,
        completedAt: a.completedAt ?? null,
        converted: intentScore != null && intentScore >= QUALIFIED_INTENT,
        isCurrent: a.campaignId === campaignId,
        callId,
        recordingUrl,
      };
    });
    const convertedOnAttempt =
      attempts.find((a) => a.converted)?.attempt ?? null;

    // Prefer per-call intent score, fall back to the campaign-lead row, then
    // the lead-wide rollup. Same precedence for the reason text.
    const intentScore =
      latest?.intentScore ?? cl.intentScore ?? cl.finalIntentScore ?? null;

    // Transcript precedence: ai_call_logs (canonical) → follow_up_history
    // (older calls that ran before ai_call_logs upsert existed).
    const transcript = latest?.transcript || lastHistory.transcript || null;

    // Duration falls back to completedAt - startedAt when ai_call_logs
    // didn't capture call_duration (older webhook paths, ElevenLabs payloads
    // missing the field). Caps at 2 hours to guard against bad timestamps.
    let callDuration = latest?.callDuration ?? null;
    if (
      (callDuration == null || callDuration <= 0) &&
      cl.startedAt &&
      cl.completedAt
    ) {
      const diffSec = Math.round(
        (new Date(cl.completedAt).getTime() -
          new Date(cl.startedAt).getTime()) /
          1000,
      );
      if (diffSec > 0 && diffSec < 2 * 60 * 60) callDuration = diffSec;
    }

    const summary = buildSummary({
      callSummary: latest?.summary ?? null,
      overallSummary: cl.overallSummary ?? null,
      memory: (cl.memory as LeadMemory | null) ?? null,
      outcome: cl.callOutcome ?? lastHistory.outcome ?? null,
      intentScore,
      analysis: lastHistory.analysis,
      hasTranscript: Boolean(transcript),
    });

    return successResponse({
      leadName: cl.shopName || cl.dealerName || "Lead",
      phone: cl.phone,
      state: cl.state,
      city: cl.city,
      campaignLeadStatus: cl.status,
      callOutcome: cl.callOutcome,
      startedAt: cl.startedAt,
      completedAt: cl.completedAt,
      bolnaCallId: cl.bolnaCallId,
      // Canonical ai_call_logs.call_id of the call whose score is shown — the
      // key the correction UI POSTs back. Falls back to the campaign-lead's
      // bolna_call_id for rows that predate ai_call_logs upsert.
      callId: latest?.callId ?? cl.bolnaCallId ?? null,
      // Raw signals behind the score, for deep-mode per-signal correction.
      signals: latest?.signals ?? null,
      intentScore,
      intentReason: latest?.intentReason ?? null,
      callDuration,
      // Prefer the stored URL (Bolna, or an already re-hosted ElevenLabs call).
      // When it's still empty but we have a call id, hand back the self-healing
      // proxy route — it re-hosts the ElevenLabs audio on first hit and backfills
      // recording_url, so the drawer player lights up even for older calls that
      // never had a URL stored.
      recordingUrl:
        latest?.recordingUrl ??
        (latest?.callId
          ? `/api/ai-dialer/recording/${encodeURIComponent(latest.callId)}`
          : null),
      summary,
      transcript,
      conversation: lastHistory.conversation,
      provider: lastHistory.provider,
      callStatus: latest?.status ?? null,
      nextAction: latest?.nextAction ?? null,
      analysis: lastHistory.analysis,
      scoreBreakdown: lastHistory.scoreBreakdown,
      scoringVersion: lastHistory.scoringVersion,
      attempts,
      convertedOnAttempt,
    });
  },
);
