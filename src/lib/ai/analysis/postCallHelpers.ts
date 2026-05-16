// Shared helpers used by both Bolna and ElevenLabs post-call pipelines.
// Pulled out of the per-provider webhook handlers (where they were
// duplicated verbatim) so a fix to scoring or callback-time parsing
// reaches both providers at once.

export function getValidDate(input: unknown): Date | null {
  if (!input) return null;
  const d = new Date(input as string | number | Date);
  return isNaN(d.getTime()) ? null : d;
}

export function extractDealerLines(transcript: string): string {
  return transcript
    .split("\n")
    .filter((line) => line.toLowerCase().startsWith("user:"))
    .map((line) => line.replace(/^user:\s*/i, ""))
    .join(" ");
}

export function parseCallbackTimeFromTranscript(
  transcript: string,
): Date | null {
  if (!transcript) return null;

  const now = Date.now();
  const t = extractDealerLines(transcript).toLowerCase();

  const patterns: { regex: RegExp; multiplierMs: number }[] = [
    { regex: /(\d+)\s*(second|sec|सेकंड)/i, multiplierMs: 1000 },
    {
      regex: /(\d+)\s*(minute|min|मिनट|मिनिट|मिन)/i,
      multiplierMs: 60 * 1000,
    },
    {
      regex: /(\d+)\s*(hour|hr|घंटा|घंटे|ghanta|ghante)/i,
      multiplierMs: 60 * 60 * 1000,
    },
    { regex: /(\d+)\s*(day|din|दिन)/i, multiplierMs: 24 * 60 * 60 * 1000 },
  ];

  for (const { regex, multiplierMs } of patterns) {
    const match = t.match(regex);
    if (match) {
      const value = parseInt(match[1], 10);
      if (!isNaN(value) && value > 0) {
        return new Date(now + value * multiplierMs);
      }
    }
  }

  if (/kal|tomorrow|कल/.test(t)) return new Date(now + 24 * 60 * 60 * 1000);
  if (/parso|day after|परसों/.test(t))
    return new Date(now + 48 * 60 * 60 * 1000);
  if (/thodi der|thoda time|थोड़ी देर|थोड़ा टाइम/.test(t))
    return new Date(now + 30 * 60 * 1000);

  return null;
}

// Apply guardrails over the raw LLM analysis so downstream code can trust
// the numbers and outcome labels. Kept in sync with what was previously
// inlined in each provider's webhookHandler.
export type NormalizedAnalysis = {
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
  memory: {
    requirement?: string | null;
    product_interest?: string | null;
    quantity?: string | null;
    intent_summary?: string;
    followup_reason?: string | null;
  };
};

export function normalizeAnalysis(analysis: any): NormalizedAnalysis {
  const safe: NormalizedAnalysis = {
    outcome: analysis?.outcome || "unknown",
    callback_time: analysis?.callback_time || null,
    intent_score: Math.max(
      0,
      Math.min(100, Number(analysis?.intent_score || 0)),
    ),
    analysis: analysis?.analysis || {
      next_step_commitment: 0,
      urgency_signals: 0,
      product_curiosity: 0,
      need_acknowledgment: 0,
      objection_quality: 0,
      engagement_depth: 0,
      intent_score: 0,
    },
    memory: analysis?.memory || {},
  };

  const hasQuantity = !!safe.memory?.quantity;
  const hasCallback =
    safe.outcome === "callback_requested" ||
    (safe.memory?.followup_reason || "").toLowerCase().includes("callback");

  if (hasCallback) safe.outcome = "callback_requested";
  if (hasQuantity && safe.analysis.product_curiosity < 5)
    safe.analysis.product_curiosity = 7;
  if (hasCallback && safe.intent_score < 50) safe.intent_score = 60;
  if (hasQuantity && hasCallback && safe.intent_score < 70)
    safe.intent_score = 75;

  return safe;
}

export function resolveNextCallAt(
  analysis: NormalizedAnalysis,
  transcript: string,
  action: string,
): Date | null {
  if (action !== "schedule_call") return null;

  const fromGemini = getValidDate(analysis.callback_time);
  if (fromGemini) return fromGemini;

  const fromTranscript = parseCallbackTimeFromTranscript(transcript);
  if (fromTranscript) return fromTranscript;

  const score = analysis.intent_score;
  const delayMs =
    score >= 75
      ? 30 * 60 * 1000
      : score >= 50
        ? 2 * 60 * 60 * 1000
        : 24 * 60 * 60 * 1000;

  return new Date(Date.now() + delayMs);
}
