// Version tags for the deterministic intent-scoring engine.
//
// Bump SCORING_VERSION whenever a weight, cap, or the formula in
// computeIntentScore.ts changes — every persisted score is stamped with it so
// old and new scores stay distinguishable in audits (a re-score is a no-op only
// if the version + signals are unchanged).
//
// Bump SIGNAL_SCHEMA_VERSION when the extracted-signal shape (signals.ts) or the
// extraction prompt changes in a way that alters what the LLM emits.
export const SCORING_VERSION = "intent-2.0.0";
export const SIGNAL_SCHEMA_VERSION = "signals-1.0.0";

// Tags the EXTRACTION prompt (parser.ts) + its few-shot calibration set
// (analysis/calibrationExamples.ts). Bump whenever the prompt wording, the
// thin-call rule, or the calibration examples change — this is the Lever-A
// (extraction-side) counterpart to SCORING_VERSION, so an audit can tell
// whether a signal shift came from a new prompt or a new weight table.
export const EXTRACTION_VERSION = "extract-1.1.0";
