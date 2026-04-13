import { ParsedData } from "./types";

export function calculateScore(parsed: ParsedData) {
  let score = 0;

  let next_step_commitment = 3;
  let urgency_signals = 2;
  let product_curiosity = 5;
  let need_acknowledgment = 5;
  let objection_quality = 5;
  let engagement_depth = 5;

  if (parsed.outcome === "interested") {
    score += 40;
    next_step_commitment = 9;
    urgency_signals = 7;
  }

  if (parsed.outcome === "callback_requested") {
    score += 20;
    next_step_commitment = 7;
    urgency_signals = 6;
  }

  if (parsed.outcome === "not_interested") {
    score -= 20;
  }

  return {
    intent_score: Math.max(0, Math.min(score, 100)),

    next_step_commitment,
    urgency_signals,
    product_curiosity,
    need_acknowledgment,
    objection_quality,
    engagement_depth,
  };
}
