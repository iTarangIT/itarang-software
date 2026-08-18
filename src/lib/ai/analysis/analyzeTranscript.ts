// Orchestrates the two concerns: extract (LLM, facts only) → band (deterministic).
// Returns a discriminated union so callers can branch on failure
// (→ needs_review) instead of silently banding a real lead on garbage.
//
// The result also carries derived legacy-shaped fields (`outcome`, `memory`)
// so existing storage glue keeps working while `band` + `score_breakdown` drive
// the truthful CRM handoff (docs/intent_docs/intent_score.pdf).

import { extractSignals } from "./parser";
import {
  computeBand,
  deriveOutcome,
  toLegacyMemory,
  type QualificationSignals,
  type SignalLine,
  type Band,
  type CallStatus,
  type InterestLevel,
  type BandAction,
  type LegacyOutcome,
  type LegacyMemory,
} from "@/lib/ai/scoring";

export interface AnalysisOk {
  status: "ok";
  signals: QualificationSignals;
  // ── Band outputs ──
  band: Band | null; // null only for dropped_empty (no band written)
  call_status: CallStatus;
  info_signals_count: number; // 0..5 — Qualified-queue sort key
  interest_level: InterestLevel | null;
  intent_score: number; // = band lead_score (90/60/30/0); carried numeric
  action: BandAction;
  hard_negative: boolean;
  score_breakdown: SignalLine[];
  scoring_version: string;
  // E-250 — which PROMPT read the transcript. scoring_version above records
  // which BAND RULE ran; these record the extraction side, so an audit can tell
  // whether a shift came from a new rule or from new teaching. The hash is
  // needed because the calibration set now lives in the DB and changes without
  // a deploy, so the version string alone no longer identifies the prompt.
  extraction_version: string;
  calibration_set_hash: string;
  // ── Derived back-compat shapes ──
  outcome: LegacyOutcome;
  memory: LegacyMemory;
  // The band model never extracts a callback time; kept null for the shared
  // resolveNextCallAt (it falls back to a score-tiered / transcript-parsed delay).
  callback_time: string | null;
}

export interface AnalysisFailed {
  status: "failed";
  reason: string;
}

export type AnalysisResult = AnalysisOk | AnalysisFailed;

export async function analyzeTranscript(transcript: string): Promise<AnalysisResult> {
  const extraction = await extractSignals(transcript);
  if (extraction.status === "failed") {
    // Genuine extraction failure (no JSON / network / schema) → needs_review,
    // keep any prior band. An all-"no" extraction is NOT a failure here: it is a
    // legitimate Cold/Disqualified the band rule handles deterministically.
    return { status: "failed", reason: `extraction:${extraction.reason}` };
  }

  const { signals } = extraction;
  const result = computeBand(signals);

  return {
    status: "ok",
    signals,
    band: result.band,
    call_status: result.call_status,
    info_signals_count: result.info_signals_count,
    interest_level: result.interest_level,
    intent_score: result.lead_score,
    action: result.action,
    hard_negative: result.hard_negative,
    score_breakdown: result.score_breakdown,
    scoring_version: result.scoring_version,
    extraction_version: extraction.extractionVersion,
    calibration_set_hash: extraction.calibrationSetHash,
    outcome: deriveOutcome(signals),
    memory: toLegacyMemory(signals),
    callback_time: null,
  };
}
