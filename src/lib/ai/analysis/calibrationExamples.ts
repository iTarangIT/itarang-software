// Few-shot calibration set for the extraction LLM.
//
// These are worked examples — a transcript paired with the CORRECT factual
// yes/no signals a human reviewer confirmed. They are injected into the
// extraction prompt (parser.ts) so the model learns, by example, the rules that
// matter most for the band model: (1) a bare "जी / haan" in reply to "are you a
// lithium battery dealer?" IS lithium_dealer = "yes", and "unknown" is only for
// a question that was never answered; (2) mark a signal "yes" only on EXPLICIT
// disclosure; (3) a PASSIVE "ok/theek hai" to an agent-offered callback DOES
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
    why: "A bare 'जी' to the lithium-dealer question COUNTS as lithium_dealer=yes. He then gave his monthly volume, and a passive ok to an agent-offered callback counts as callback_agreed=yes. (→ Qualified, 90.)",
    transcript: [
      "agent: नमस्ते sir! Priya बोल रही हूँ iTarang से। क्या आप lithium battery dealer हैं?",
      "user: जी।",
      "agent: बढ़िया sir। हम lithium-ion batteries EMI पर देते हैं। आप महीने में कितनी units करते हैं?",
      "user: 12 से 15 गाड़ी महीने की निकलती है।",
      "agent: बढ़िया sir। मैं आपको detail भेजने के लिए कल call करूँ?",
      "user: हाँ ठीक है, कर लेना।",
    ].join("\n"),
    signals: {
      ...EMPTY_SIGNALS,
      lithium_dealer: "yes",
      relevant_dealer: "yes",
      dealer_segment: "e_rickshaw",
      dealer_role: "dealer",
      volume_shared: "yes",
      pitch_heard: "yes",
      callback_agreed: "yes",
      disqualifier: "none",
      evidence: {
        ...EMPTY_SIGNALS.evidence,
        lithium_dealer: "जी (to 'are you a lithium battery dealer?')",
        relevant_dealer: "deals e-rickshaw batteries",
        volume_shared: "12-15 units a month",
        callback_agreed: "haan theek hai, kar lena (passive ok to agent-offered callback)",
      },
      language: "hinglish",
      call_summary: "Lithium dealer doing 12-15 units/month; passively agreed to a callback.",
    },
  },
  {
    why: "Saying he works on lithium batteries is lithium_dealer=yes even without the direct question. Spec, volume, financier and financing need are each read only on explicit disclosure. (→ Qualified, 90.)",
    transcript: [
      "agent: namaste sir, Priya from iTarang, Trontek lithium battery with EMI financing.",
      "user: haan. main 60V 100Ah lithium pe kaam karta hoon, mahine ke 30 set. abhi Bajaj Finance se loan leta hoon par battery ke daam badh rahe hain, financing toh chahiye hi.",
      "agent: bilkul sir, hum waEMI set karte hain.",
      "user: dekho rate accha ho toh baat banegi.",
    ].join("\n"),
    signals: {
      ...EMPTY_SIGNALS,
      lithium_dealer: "yes",
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
        lithium_dealer: "main 60V 100Ah lithium pe kaam karta hoon",
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
    why: "Line dropped after a bare hello — the lithium question was never answered, so lithium_dealer=unknown (NOT no). disqualifier=call_dropped, all info 'no'. (→ dropped_empty, auto-retry, no band.)",
    transcript: [
      "agent: नमस्ते sir, Priya iTarang से, lithium battery EMI...",
      "user: हैलो? हैलो?",
      "[call disconnected]",
    ].join("\n"),
    signals: {
      ...EMPTY_SIGNALS,
      lithium_dealer: "unknown",
      relevant_dealer: "no",
      pitch_heard: "no",
      callback_agreed: "no",
      disqualifier: "call_dropped",
      language: "hinglish",
      call_summary: "Call dropped after a bare hello; nothing was discussed.",
    },
  },
  {
    why: "He deals in batteries but only lead-acid — that is lithium_dealer=no, even though he is a battery dealer (relevant_dealer=yes). (→ Disqualified.)",
    transcript: [
      "agent: नमस्ते sir, Priya iTarang से। क्या आप lithium battery dealer हैं?",
      "user: नहीं जी, हम तो lead-acid ही बेचते हैं, Exide और Amaron।",
      "agent: ठीक है sir, धन्यवाद।",
    ].join("\n"),
    signals: {
      ...EMPTY_SIGNALS,
      lithium_dealer: "no",
      relevant_dealer: "yes",
      dealer_segment: "battery",
      dealer_role: "dealer",
      pitch_heard: "no",
      callback_agreed: "no",
      disqualifier: "none",
      evidence: {
        ...EMPTY_SIGNALS.evidence,
        lithium_dealer: "nahi ji, hum toh lead-acid hi bechte hain",
        relevant_dealer: "sells lead-acid batteries (Exide, Amaron)",
      },
      language: "hindi",
      call_summary: "Dealer sells only lead-acid batteries, not lithium.",
    },
  },
];

// Renders a calibration set as text appended to the extraction prompt. Empty
// string when the set is empty (so the prompt is unchanged with no examples).
//
// E-250: takes the set as an ARGUMENT rather than reading the module constant.
// The active set now lives in the intent_calibration_examples table and is
// loaded at request time by calibrationStore.ts, so an admin can teach the
// model without a code edit or a deploy. This function stays a pure renderer —
// it must not know where the examples came from, so the DB path and the seed
// fallback produce byte-identical prompt text.
export function renderCalibrationExamples(
  examples: CalibrationExample[] = CALIBRATION_EXAMPLES,
): string {
  if (examples.length === 0) return "";
  const blocks = examples.map((ex, i) => {
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
