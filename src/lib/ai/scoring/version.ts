// Version tags for the deterministic intent-qualification engine.
//
// Bump SCORING_VERSION whenever the band rule in computeBand.ts changes — every
// persisted band/score is stamped with it so old and new results stay
// distinguishable in audits (a re-score is a no-op only if the version + signals
// are unchanged).
//
// Bump SIGNAL_SCHEMA_VERSION when the extracted-signal shape (signals.ts) or the
// extraction prompt changes in a way that alters what the LLM emits.
//
// qualification-1.0.0: replaced the weighted BANT intent-score model with the
// deterministic yes/no-signal band model (docs/intent_docs/intent_score.pdf).
// The signal shape changed wholesale (signals-2.0.0) and the prompt is
// facts-only with passive-callback-counts (extract-2.0.0). Old rows keep their
// own version stamps and still render via shape detection.
export const SCORING_VERSION = "qualification-1.0.0";
export const SIGNAL_SCHEMA_VERSION = "signals-2.0.0";

// Tags the EXTRACTION prompt (parser.ts) + its few-shot calibration set
// (analysis/calibrationExamples.ts). Bump whenever the prompt wording or the
// calibration examples change — this is the Lever-A (extraction-side)
// counterpart to SCORING_VERSION, so an audit can tell whether a signal shift
// came from a new prompt or a new band rule.
export const EXTRACTION_VERSION = "extract-2.0.0";
