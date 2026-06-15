import { leadStatusFor, type LeadStatus } from "@/lib/ai/scoring";

// Back-compat: a score-only status label. Live callers should prefer the band,
// which is passed through explicitly; this stays for any bare-score caller.
export function getLeadStatus(score: number) {
  return leadStatusFor(score);
}

// hot/warm/cold chip for the inside-sales queue, derived from the headline
// status. Disqualified leads carry no interest level.
function interestLevelFor(status: LeadStatus): "hot" | "warm" | "cold" | null {
  switch (status) {
    case "qualified":
      return "hot";
    case "warm":
      return "warm";
    case "cold":
      return "cold";
    default:
      return null;
  }
}

// The loosely-typed CRM glue: finalizeCall hands us a spread of the dealer_leads
// row plus the new per-call band analysis. Typed permissively (the row has dozens
// of columns) but with the fields this function actually reads spelled out.
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
  conversation?: unknown[];
  memory?: Record<string, unknown> | null;
  provider?: string;
  // Band model (docs/intent_docs/intent_score.pdf). intentScore is the band's
  // lead_score (90/60/30/0), carried in the numeric field.
  intentScore?: number;
  band?: string | null;
  callStatus?: string | null;
  infoSignalsCount?: number | null;
  signals?: unknown;
  scoreBreakdown?: unknown;
  scoringVersion?: string | null;
  hardNegative?: boolean;
}

function getSafeISOString(date: unknown): string | null {
  if (!date) return null;

  const d = new Date(date as string | number | Date);
  if (isNaN(d.getTime())) return null;

  return d.toISOString();
}

// Append a per-attempt entry and recompute the lead's headline state.
//
// final_intent_score is the lead's BEST/most-qualifying state — max across
// attempts — so a hot lead is never demoted by a brief later callback. The
// exception: a hard-negative latest call (relevant_dealer=no, or a dont_call /
// hostile / not_interested disqualifier) CAN pull the score down and disqualify
// the lead. A dropped_empty call never reaches here — finalizeCall tags it and
// leaves the lead untouched.
//
// Each attempt's full signals + yes/no breakdown + band + scoring_version are
// stored in follow_up_history for audit; a dropped_partial entry is tagged
// "resume — call was cut off" so inside-sales resumes rather than cold-retries.
export function updateLeadAfterCall(
  existingLead: ExistingLeadState,
  payload: CallUpdatePayload,
) {
  const history = existingLead?.follow_up_history || [];
  const newAttempt = history.length + 1;

  const thisScore = Number(payload?.intentScore ?? 0) || 0;
  const hardNegative = !!payload?.hardNegative;
  const droppedPartial = payload?.callStatus === "dropped_partial";

  const newEntry = {
    attempt: newAttempt,
    called_at: new Date().toISOString(),
    outcome: payload?.outcome || "unknown",
    dealer_said: payload?.transcript || "",
    transcript: payload?.transcript || "",
    conversation: payload?.conversation || [],
    next_call_at: getSafeISOString(payload?.nextCallAt),
    // Minimal legacy `analysis` blob so older lead-list views that read
    // follow_up_history[*].analysis.intent_score keep showing the number. The
    // 6 BANT bars are gone in the band model; the drawer renders score_breakdown.
    analysis: { intent_score: thisScore },
    // Auditable band data.
    intent_score: thisScore,
    band: payload?.band ?? null,
    call_status: payload?.callStatus ?? "complete",
    info_signals_count: payload?.infoSignalsCount ?? null,
    // Inside-sales hint for a call that was cut off after disclosing substance.
    resume_note: droppedPartial ? "resume — call was cut off" : null,
    signals: payload?.signals ?? null,
    score_breakdown: payload?.scoreBreakdown ?? null,
    scoring_version: payload?.scoringVersion ?? null,
    provider: payload?.provider || "bolna",
  };

  const updatedHistory = [...history, newEntry];
  const totalAttempts = updatedHistory.length;

  const prevFinal = Number(existingLead?.final_intent_score ?? 0) || 0;
  const finalScore = hardNegative ? thisScore : Math.max(prevFinal, thisScore);

  // The band uniquely maps to the score (90→qualified / 60→warm / 30→cold /
  // 0→disqualified), so the headline status follows the BEST score directly.
  const currentStatus = leadStatusFor(finalScore);
  const interestLevel = interestLevelFor(currentStatus);

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
    interest_level: interestLevel,
    // Per-call columns mirror the latest call so the queue/drawer don't have to
    // dig into follow_up_history.
    call_status: payload?.callStatus ?? "complete",
    info_signals_count: payload?.infoSignalsCount ?? null,
    intent_band: payload?.band ?? null,
    memory: mergedMemory,
  };
}
