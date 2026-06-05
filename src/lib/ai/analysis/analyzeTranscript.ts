// Orchestrates the three concerns: extract (LLM) → score (deterministic) →
// route (deterministic). Returns a discriminated union so callers can branch on
// failure (→ needs_review) instead of silently scoring a real lead to zero.
//
// The result also carries legacy-shaped fields (`outcome`, `analysis`, `memory`)
// derived from the signals so existing storage and secondary UI keep working
// while the new `signals` + `score_breakdown` drive the truthful breakdown.

import { extractSignals } from "./parser";
import {
  computeIntentScore,
  decideRoute,
  deriveOutcome,
  toLegacySubScores,
  toLegacyMemory,
  hasUsableSignal,
  type IntentSignals,
  type ScoreContribution,
  type RouteDecision,
  type LegacyOutcome,
  type LegacySubScores,
  type LegacyMemory,
} from "@/lib/ai/scoring";

export interface AnalysisOk {
  status: "ok";
  signals: IntentSignals;
  intent_score: number;
  score_breakdown: ScoreContribution[];
  qualified_gate: boolean;
  scoring_version: string;
  outcome: LegacyOutcome;
  route: RouteDecision;
  callback_time: string | null;
  // Legacy back-compat shapes.
  analysis: LegacySubScores;
  memory: LegacyMemory;
}

export interface AnalysisFailed {
  status: "failed";
  reason: string;
}

export type AnalysisResult = AnalysisOk | AnalysisFailed;

export async function analyzeTranscript(transcript: string): Promise<AnalysisResult> {
  const extraction = await extractSignals(transcript);
  if (extraction.status === "failed") {
    return { status: "failed", reason: `extraction:${extraction.reason}` };
  }

  const { signals } = extraction;

  // No usable signal at all → we couldn't understand the call. Treat as a
  // failure (needs_review) rather than a disqualifying zero.
  if (!hasUsableSignal(signals)) {
    return { status: "failed", reason: "no_usable_signal" };
  }

  const score = computeIntentScore(signals);
  const route = decideRoute(score.intent_score, signals, score.qualified_gate);
  const outcome = deriveOutcome(signals);

  return {
    status: "ok",
    signals,
    intent_score: score.intent_score,
    score_breakdown: score.score_breakdown,
    qualified_gate: score.qualified_gate,
    scoring_version: score.scoring_version,
    outcome,
    route,
    callback_time: signals.callback_time,
    analysis: toLegacySubScores(signals, score.intent_score),
    memory: toLegacyMemory(signals),
  };
}
