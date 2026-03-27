import { parseTranscript } from "./parser";

export async function analyzeTranscript(transcript: string) {
  const parsed = await parseTranscript(transcript);

  return {
    outcome: parsed.outcome,
    callback_time: parsed.callback_time,
    intent_score: parsed.analysis.intent_score,
    analysis: parsed.analysis,
    memory: parsed.memory,
  };
}
