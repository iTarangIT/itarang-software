export function getLeadStatus(score: number) {
  if (score >= 75) return "qualified";
  if (score >= 40) return "warm";
  if (score >= 10) return "cold";
  return "disqualified";
}

function getSafeISOString(date: any): string | null {
  if (!date) return null;

  const d = new Date(date);
  if (isNaN(d.getTime())) return null;

  return d.toISOString();
}

export function updateLeadAfterCall(existingLead: any, payload: any) {
  const history = existingLead?.follow_up_history || [];

  const newAttempt = history.length + 1;

  const newEntry = {
    attempt: newAttempt,
    called_at: new Date().toISOString(),
    outcome: payload?.outcome || "unknown",
    dealer_said: payload?.transcript || "",
    transcript: payload?.transcript || "",
    conversation: payload?.conversation || [],
    next_call_at: getSafeISOString(payload?.nextCallAt),
    analysis: payload?.analysis || {
      next_step_commitment: 0,
      urgency_signals: 0,
      product_curiosity: 0,
      need_acknowledgment: 0,
      objection_quality: 0,
      engagement_depth: 0,
      intent_score: 0,
    },
  };

  const updatedHistory = [...history, newEntry];

  const finalScore = newEntry.analysis.intent_score || 0;

  const totalAttempts = updatedHistory.length;

  const currentStatus = getLeadStatus(finalScore);

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
