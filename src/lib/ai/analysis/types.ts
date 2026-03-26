export interface ParsedData {
  outcome: "interested" | "not_interested" | "callback_requested" | "unknown";
  callback_time: string | null;
  language: string;
}

export interface AnalysisResult {
  outcome: string;
  callback_time: string | null;
  intent_score: number;

  analysis: {
    next_step_commitment: number;
    urgency_signals: number;
    product_curiosity: number;
    need_acknowledgment: number;
    objection_quality: number;
    engagement_depth: number;
    intent_score: number;
  };
}
