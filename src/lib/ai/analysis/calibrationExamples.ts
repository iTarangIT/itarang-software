// Few-shot calibration set for the extraction LLM (Lever A of the learning loop).
//
// These are worked examples — a transcript paired with the CORRECT conservative
// signals a human reviewer confirmed. They are injected into the extraction
// prompt (parser.ts) so the model learns, by example, not to over-read thin or
// garbled calls (the failure that scored a 2-line 39s call a 65).
//
// Curation rule: add the highest-disagreement rows from intent_score_feedback
// (export them with `npm run intent:export-golden`, pick the worst misses, and
// hand-author the corrected signals here). Keep the set SMALL and BALANCED —
// include at least one genuinely strong call so the model stays calibrated in
// both directions rather than globally pessimistic. Bump EXTRACTION_VERSION in
// version.ts whenever this set or the prompt rules change.

import { EMPTY_SIGNALS, type IntentSignals } from "@/lib/ai/scoring";

export interface CalibrationExample {
  // Why this example is here — shown to the model as the example's heading.
  why: string;
  transcript: string;
  // The correct signals a human confirmed for this transcript.
  signals: IntentSignals;
}

export const CALIBRATION_EXAMPLES: CalibrationExample[] = [
  {
    why: "Thin, garbled 39s call: a 'yes' and a competitor name are NOT curiosity or engagement. Do not over-read noise.",
    transcript: [
      "agent: नमस्ते sir! Priya बोल रही हूँ iTarang Technologies से। हम Trontek lithium-ion batteries supply करते हैं और driver के लिए financing भी setup करते हैं। क्या अभी दो minute बात हो सकती है?",
      "user: हम्म, yes.",
      "agent: Acha sir, आप currently कौन सी brand की batteries deal करते हैं?",
      "user: Estman CLL. ये आपको तो बोले-बोले कुछ नहीं बोला, हम भी तो बोले थे। क्या कहा था तुम्हारा? मगर…",
    ].join("\n"),
    signals: {
      ...EMPTY_SIGNALS,
      // The dealer named their current brand but asked nothing and engaged barely.
      need: { level: "unknown", evidence: "unknown" },
      budget: { level: "unknown", evidence: "unknown" },
      engagement: { level: "weak", evidence: "one-word 'yes' then a garbled line" },
      curiosity: { level: "none", evidence: "asked no product questions" },
      timeline: { level: "unknown", evidence: "unknown" },
      objection_quality: { level: "none", evidence: "no objection raised" },
      authority: { level: "decision_maker", evidence: "single-dealer shop" },
      facts: { quantity: null, callback_requested: false, competitor_named: "Estman CLL" },
      language: "hinglish",
      call_summary: "Dealer currently uses Estman CLL; barely engaged before the line garbled.",
    },
  },
  {
    why: "Genuinely strong buyer: explicit volume + financing ask + booking. Read these signals at full strength — calibration must stay two-sided.",
    transcript: [
      "agent: namaste sir, Priya from iTarang, Trontek lithium battery with EMI financing.",
      "user: haan mujhe chahiye. mere paas 20 e-rickshaw hain, sabki battery badalni hai. EMI ka kya plan hai? rate kya hai?",
      "agent: ji sir, 12 month EMI available hai. kal aapke shop pe visit fix karein?",
      "user: haan kal subah aa jao, main owner hi hoon.",
    ].join("\n"),
    signals: {
      ...EMPTY_SIGNALS,
      need: { level: "strong", evidence: "20 e-rickshaws, all batteries to replace" },
      budget: { level: "strong", evidence: "asked for EMI plan and rate" },
      engagement: { level: "strong", evidence: "detailed back-and-forth" },
      curiosity: { level: "strong", evidence: "asked EMI plan and rate" },
      timeline: { level: "now", evidence: "kal subah aa jao" },
      objection_quality: { level: "none", evidence: "no objection" },
      authority: { level: "decision_maker", evidence: "main owner hi hoon" },
      facts: { quantity: "20", callback_requested: false, competitor_named: null },
      language: "hinglish",
      call_summary: "Owner with 20 e-rickshaws wants all batteries replaced, asked EMI/rate, booked a visit.",
    },
  },
];

// Renders the calibration set as text appended to the extraction prompt. Empty
// string when the set is empty (so the prompt is unchanged with no examples).
export function renderCalibrationExamples(): string {
  if (CALIBRATION_EXAMPLES.length === 0) return "";
  const blocks = CALIBRATION_EXAMPLES.map((ex, i) => {
    return `EXAMPLE ${i + 1} — ${ex.why}
CONVERSATION:
"""
${ex.transcript}
"""
CORRECT SIGNALS (what a human reviewer confirmed):
${JSON.stringify(ex.signals)}`;
  }).join("\n\n");

  return `\nCALIBRATION EXAMPLES (learn the correct conservative reading from these — do NOT copy their values, apply the same judgement to the conversation above):\n\n${blocks}\n`;
}
