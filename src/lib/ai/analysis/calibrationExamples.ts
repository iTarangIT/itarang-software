// Few-shot calibration set for the extraction LLM.
//
// These are worked examples — a transcript paired with the CORRECT factual
// yes/no signals a human reviewer confirmed. They are injected into the
// extraction prompt (parser.ts) so the model learns, by example, the two rules
// that matter most for the band model: (1) mark a signal "yes" only on EXPLICIT
// disclosure, and (2) a PASSIVE "ok/theek hai" to an agent-offered callback DOES
// count as callback_agreed = "yes".
//
// Curation rule: add the highest-disagreement rows from intent_score_feedback
// (export with `npm run intent:export-golden`, pick the worst misses, hand-author
// the corrected signals here). Keep the set SMALL and BALANCED. Bump
// EXTRACTION_VERSION in version.ts whenever this set or the prompt rules change.

import { EMPTY_SIGNALS, type QualificationSignals } from "@/lib/ai/scoring";

export interface CalibrationExample {
  // Why this example is here — shown to the model as the example's heading.
  why: string;
  transcript: string;
  // The correct signals a human confirmed for this transcript.
  signals: QualificationSignals;
}

export const CALIBRATION_EXAMPLES: CalibrationExample[] = [
  {
    why: "Passive agreement to an AGENT-OFFERED callback COUNTS as callback_agreed=yes. The dealer disclosed his monthly volume; nothing else. (→ Qualified on the callback.)",
    transcript: [
      "agent: नमस्ते sir! Priya बोल रही हूँ iTarang से। हम lithium-ion batteries EMI पर देते हैं। आप महीने में कितनी units करते हैं?",
      "user: 12 से 15 गाड़ी महीने की निकलती है।",
      "agent: बढ़िया sir। मैं आपको detail भेजने के लिए कल call करूँ?",
      "user: हाँ ठीक है, कर लेना।",
    ].join("\n"),
    signals: {
      ...EMPTY_SIGNALS,
      relevant_dealer: "yes",
      dealer_segment: "e_rickshaw",
      dealer_role: "dealer",
      volume_shared: "yes",
      pitch_heard: "yes",
      callback_agreed: "yes",
      disqualifier: "none",
      evidence: {
        ...EMPTY_SIGNALS.evidence,
        relevant_dealer: "deals e-rickshaw batteries",
        volume_shared: "12-15 units a month",
        callback_agreed: "haan theek hai, kar lena (passive ok to agent-offered callback)",
      },
      language: "hinglish",
      call_summary: "Dealer does 12-15 units/month and passively agreed to a callback.",
    },
  },
  {
    why: "Strong substance: spec + volume + current financier + financing need = 4 info signals. Qualified on substance even without a callback. Read each only on explicit disclosure.",
    transcript: [
      "agent: namaste sir, Priya from iTarang, Trontek lithium battery with EMI financing.",
      "user: haan. main 60V 100Ah lithium pe kaam karta hoon, mahine ke 30 set. abhi Bajaj Finance se loan leta hoon par battery ke daam badh rahe hain, financing toh chahiye hi.",
      "agent: bilkul sir, hum waEMI set karte hain.",
      "user: dekho rate accha ho toh baat banegi.",
    ].join("\n"),
    signals: {
      ...EMPTY_SIGNALS,
      relevant_dealer: "yes",
      dealer_segment: "battery",
      dealer_role: "dealer",
      battery_spec_shared: "yes",
      volume_shared: "yes",
      existing_financier_shared: "yes",
      financing_need_expressed: "yes",
      financing_value_acknowledged: "no",
      pitch_heard: "yes",
      callback_agreed: "no",
      disqualifier: "none",
      evidence: {
        ...EMPTY_SIGNALS.evidence,
        relevant_dealer: "works on EV batteries",
        battery_spec_shared: "60V 100Ah lithium",
        volume_shared: "30 sets a month",
        existing_financier_shared: "Bajaj Finance",
        financing_need_expressed: "battery prices rising, financing needed",
      },
      language: "hinglish",
      call_summary: "Dealer shared 60V/100Ah spec, 30 sets/month, uses Bajaj Finance, needs financing as prices rise.",
    },
  },
  {
    why: "Line dropped after a bare hello — nothing disclosed, no callback. disqualifier=call_dropped, all info 'no'. (→ dropped_empty, auto-retry, no band.)",
    transcript: [
      "agent: नमस्ते sir, Priya iTarang से, lithium battery EMI...",
      "user: हैलो? हैलो?",
      "[call disconnected]",
    ].join("\n"),
    signals: {
      ...EMPTY_SIGNALS,
      relevant_dealer: "no",
      pitch_heard: "no",
      callback_agreed: "no",
      disqualifier: "call_dropped",
      language: "hinglish",
      call_summary: "Call dropped after a bare hello; nothing was discussed.",
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

  return `\nCALIBRATION EXAMPLES (learn the correct factual reading from these — do NOT copy their values, apply the same judgement to the conversation above):\n\n${blocks}\n`;
}
