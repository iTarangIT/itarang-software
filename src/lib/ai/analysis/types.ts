// Legacy analysis types. The live result type is `AnalysisResult` in
// analyzeTranscript.ts (signals + truthful breakdown). These remain for the
// legacy 6-field follow_up_history `analysis` shape and the coarse outcome label
// that stored rows / secondary UI still read.

export type OutcomeType =
  | "interested"
  | "not_interested"
  | "callback_requested"
  | "unknown";

export type LanguageType = "hindi" | "english" | "hinglish" | "unknown";

export interface Memory {
  requirement: string | null;
  product_interest: string | null;
  quantity: string | null;
  intent_summary: string;
  followup_reason: string | null;
}

export interface Analysis {
  next_step_commitment: number;
  urgency_signals: number;
  product_curiosity: number;
  need_acknowledgment: number;
  objection_quality: number;
  engagement_depth: number;
  intent_score: number;
}
