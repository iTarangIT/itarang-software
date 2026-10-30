// Version tags for the deterministic intent-qualification engine.
//
// Bump SCORING_VERSION whenever the band rule in computeBand.ts changes — every
// persisted band/score is stamped with it so old and new results stay
// distinguishable in audits (a re-score is a no-op only if the version + signals
// are unchanged).
//
// Bump SIGNAL_SCHEMA_VERSION when the extracted-signal shape (signals.ts) or the
// extraction prompt changes in a way that alters what the LLM emits.
//
// qualification-1.0.0: replaced the weighted BANT intent-score model with the
// deterministic yes/no-signal band model (docs/intent_docs/intent_score.pdf).
// The signal shape changed wholesale (signals-2.0.0) and the prompt is
// facts-only with passive-callback-counts (extract-2.0.0). Old rows keep their
// own version stamps and still render via shape detection.
//
// qualification-2.0.0: the lithium-dealer rule. One question decides the band
// — lithium_dealer yes → Qualified 75 (90 with volume_shared), no →
// Disqualified, unknown → Cold. The five-info-signal threshold and the
// callback path to Qualified are retired. signals-2.1.0 adds lithium_dealer
// (yes/no/unknown); extract-2.1.0 teaches the prompt to read it.
//
// qualification-2.1.0: a callback is buying intent — callback_agreed or
// wants_human without a disqualifier lifts Cold → Warm (60). signals-2.2.0 adds
// callback_when / callback_at / callback_topic / wants_human; extract-2.2.0
// teaches the prompt to read them (AI dialer review, 23 Oct 2026). extract-2.2.1:
// agreeing to the agent's own "our sales manager will call" is not wants_human.
//
// qualification-2.2.0 (D9/D10, 29 Oct 2026): a lead-acid-only dealer in our
// product lines is Warm, not Disqualified; only a dealer outside them (car /
// truck / petrol-bike batteries only) is Disqualified and a hard negative.
// signals-2.3.0 replaces the single dealer_segment with product_lines
// (three_wheeler, two_wheeler, inverter_battery, inverter, solar, ess_bess);
// extract-2.3.0 widens the prompt to inverter / solar / ESS dealers.
//
// qualification-2.3.0 (30 Oct 2026): EMI finance on Trontek lithium batteries
// through an NBFC partner (Bajaj Finserv etc.) lifts the lead one step — Cold →
// Warm, lead-acid Warm → Qualified 75, lithium +10 (85 / 100). signals-2.4.0
// adds emi_finance_interest; extract-2.4.0 teaches the prompt to read it and
// spells out the product lines (L3/L5 51–72 V, scooty, lithium inverter battery).
export const SCORING_VERSION = "qualification-2.3.0";
export const SIGNAL_SCHEMA_VERSION = "signals-2.4.0";

// Tags the EXTRACTION prompt (parser.ts) + its few-shot calibration set
// (analysis/calibrationExamples.ts). Bump whenever the prompt wording or the
// calibration examples change — this is the Lever-A (extraction-side)
// counterpart to SCORING_VERSION, so an audit can tell whether a signal shift
// came from a new prompt or a new band rule.
// extract-2.3.1 (D8): callback_topic "complaint" — a problem with a battery / service he has.
// extract-2.4.0: emi_finance_interest + sharper product-line wording.
export const EXTRACTION_VERSION = "extract-2.4.0";
