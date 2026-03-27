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

export interface ParsedData {
  outcome: OutcomeType;
  callback_time: string | null;
  language: LanguageType;
  analysis: Analysis;
  memory: Memory;
}

export interface AnalysisResult {
  outcome: OutcomeType;
  callback_time: string | null;
  intent_score: number;
  analysis: Analysis;
  memory: Memory;
}
