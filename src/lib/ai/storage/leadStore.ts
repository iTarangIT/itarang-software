import { leadStatusFor } from "@/lib/ai/scoring";

// Back-compat: a score-only status label. Live callers should prefer the
// gate-aware leadStatusFor; this stays for any bare-score caller.
export function getLeadStatus(score: number) {
  return leadStatusFor(score);
}

// The loosely-typed CRM glue: finalizeCall hands us a spread of the dealer_leads
// row plus the new per-call analysis. Typed permissively (the row has dozens of
// columns) but with the fields this function actually reads spelled out.
interface ExistingLeadState {
  follow_up_history?: unknown[] | null;
  final_intent_score?: number | null;
  memory?: Record<string, unknown> | null;
  [key: string]: unknown;
}

interface CallUpdatePayload {
  transcript?: string;
  outcome?: string;
  nextCallAt?: Date | string | null;
  analysis?: unknown;
  conversation?: unknown[];
  memory?: Record<string, unknown> | null;
  provider?: string;
  intentScore?: number;
  signals?: unknown;
  scoreBreakdown?: unknown;
  scoringVersion?: string | null;
  qualifiedGate?: boolean;
  hardNegative?: boolean;
}

function getSafeISOString(date: unknown): string | null {
  if (!date) return null;

  const d = new Date(date as string | number | Date);
  if (isNaN(d.getTime())) return null;

  return d.toISOString();
}

const ZERO_SUBSCORES = {
  next_step_commitment: 0,
  urgency_signals: 0,
  product_curiosity: 0,
  need_acknowledgment: 0,
  objection_quality: 0,
  engagement_depth: 0,
  intent_score: 0,
};

// Append a per-attempt entry and recompute the lead's headline state.
//
// final_intent_score is the lead's BEST/most-qualifying state — max across
// attempts — so a hot lead is never demoted by a brief later callback. The
// exception: a hard-negative latest call (explicit not-interested / do-not-call /
// competitor-bought) CAN pull the score down and disqualify the lead.
//
// Each attempt's full signals + truthful breakdown + scoring_version are stored
// in follow_up_history for audit; the new UI renders score_breakdown from there,
// with the legacy 6-field `analysis` kept as the fallback for old rows.
export function updateLeadAfterCall(
  existingLead: ExistingLeadState,
  payload: CallUpdatePayload,
) {
  const history = existingLead?.follow_up_history || [];
  const newAttempt = history.length + 1;

  const payloadAnalysis = payload?.analysis as { intent_score?: number } | undefined;
  const thisScore = Number(payload?.intentScore ?? payloadAnalysis?.intent_score ?? 0) || 0;
  const hardNegative = !!payload?.hardNegative;

  const newEntry = {
    attempt: newAttempt,
    called_at: new Date().toISOString(),
    outcome: payload?.outcome || "unknown",
    dealer_said: payload?.transcript || "",
    transcript: payload?.transcript || "",
    conversation: payload?.conversation || [],
    next_call_at: getSafeISOString(payload?.nextCallAt),
    analysis: payload?.analysis || ZERO_SUBSCORES,
    // Auditable scoring data (new). Null on legacy/unscored entries.
    intent_score: thisScore,
    signals: payload?.signals ?? null,
    score_breakdown: payload?.scoreBreakdown ?? null,
    qualified_gate: payload?.qualifiedGate ?? null,
    scoring_version: payload?.scoringVersion ?? null,
    provider: payload?.provider || "bolna",
  };

  const updatedHistory = [...history, newEntry];
  const totalAttempts = updatedHistory.length;

  const prevFinal = Number(existingLead?.final_intent_score ?? 0) || 0;
  const finalScore = hardNegative ? thisScore : Math.max(prevFinal, thisScore);

  // The authority gate only applies when THIS call is the lead's best state;
  // when the best score came from a prior (already-qualified) attempt we trust
  // that qualification rather than blocking on this call's authority reading.
  const gateApplies = finalScore === thisScore;
  const currentStatus = hardNegative
    ? "disqualified"
    : leadStatusFor(finalScore, {
        qualified_gate: gateApplies ? payload?.qualifiedGate : undefined,
      });

  const mergedMemory = {
    ...(existingLead?.memory || {}),
    ...(payload?.memory || {}),
  };

  return {
    ...existingLead,
    follow_up_history: updatedHistory,
    total_attempts: totalAttempts,
    final_intent_score: finalScore,
    current_status: currentStatus,
    memory: mergedMemory,
  };
}
