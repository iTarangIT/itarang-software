// Shared helpers used by both Bolna and ElevenLabs post-call pipelines.
//
// NOTE: the old `normalizeAnalysis` guardrail (which bumped callback scores to
// 60/75) is GONE — scoring is now deterministic upstream (computeIntentScore),
// so there is nothing to "normalize". What remains here is callback-time
// parsing and next-call scheduling, which both pipelines still share.

import { INTENT_THRESHOLDS } from "@/lib/ai/scoring";

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

export function parseCallbackTimeFromTranscript(transcript: string): Date | null {
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
  if (/parso|day after|परसों/.test(t)) return new Date(now + 48 * 60 * 60 * 1000);
  if (/thodi der|thoda time|थोड़ी देर|थोड़ा टाइम/.test(t))
    return new Date(now + 30 * 60 * 1000);

  return null;
}

// Decide when to place the next call for a schedule_call action. Prefers an
// explicit callback time (from extraction or transcript), otherwise falls back
// to a score-tiered delay using the SAME central thresholds as routing/status.
export function resolveNextCallAt(
  analysis: { callback_time: string | null; intent_score: number },
  transcript: string,
  action: string,
): Date | null {
  if (action !== "schedule_call") return null;

  const fromModel = getValidDate(analysis.callback_time);
  if (fromModel) return fromModel;

  const fromTranscript = parseCallbackTimeFromTranscript(transcript);
  if (fromTranscript) return fromTranscript;

  const score = analysis.intent_score;
  const delayMs =
    score >= INTENT_THRESHOLDS.QUALIFIED
      ? 30 * 60 * 1000 // hot → 30 min
      : score >= INTENT_THRESHOLDS.WARM
        ? 2 * 60 * 60 * 1000 // warm → 2 h
        : 24 * 60 * 60 * 1000; // cold/callback brush-off → 24 h

  return new Date(Date.now() + delayMs);
}
