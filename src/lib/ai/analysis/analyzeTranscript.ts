import { parseTranscript } from "./parser";
import { calculateScore } from "./score";
import { AnalysisResult } from "./types";

export async function analyzeTranscript(
  transcript: string,
): Promise<AnalysisResult> {
  const parsed = await parseTranscript(transcript);

  const scoreData = calculateScore(parsed);

  return {
    outcome: parsed.outcome,
    callback_time: parsed.callback_time,
    intent_score: scoreData.intent_score,

    analysis: {
      ...scoreData,
      intent_score: scoreData.intent_score,
    },
  };
}
