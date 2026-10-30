// Structured FACTS extracted from a call transcript by the LLM — the input to
// the deterministic band engine (computeBand.ts).
//
// CRITICAL CONTRACT: the LLM's ONLY job is to report what the dealer actually
// said as yes/no facts. It must NOT score and must NOT band — the band is
// computed in code so the same call always yields the same band, traceable to
// the signals behind it (docs/intent_docs/intent_score.pdf §2).
//
// The schema is intentionally forgiving: every field `.catch()`es a bad/garbled
// value to its conservative fallback ("no" / "none" / "unknown") instead of
// failing the whole parse. A genuine failure (no JSON at all, network/timeout)
// is handled upstream in the extraction layer (parser.ts), not here.

import { z } from "zod";

// ── Enums ────────────────────────────────────────────────────────────────────

// Every business signal is a strict yes/no fact — never inferred from tone.
export const YES_NO = ["yes", "no"] as const;
// The lithium-dealer gate needs a third value: "no" disqualifies the lead while
// "never answered" only leaves it Cold, so the two must stay distinguishable.
export const YES_NO_UNKNOWN = ["yes", "no", "unknown"] as const;
// Legacy (signals <= 2.2.0): ONE segment per call. Old rows keep it and still
// display; new calls write product_lines instead (D9).
export const DEALER_SEGMENTS = [
  "battery",
  "e_rickshaw",
  "e_2w",
  "multiple",
  "none",
] as const;
// D9 (signals-2.3.0) — every line iTarang sells into. A dealer in ANY of them is
// relevant; one in none of them (car / truck / petrol-bike batteries only) is not.
export const PRODUCT_LINES = [
  "three_wheeler", // e-rickshaw / e-auto (L3, L5) batteries, 51–72 V
  "two_wheeler", // electric two-wheeler batteries (e-scooter, e-bike, "scooty")
  "inverter_battery",
  "inverter",
  "solar",
  "ess_bess",
] as const;
export const PRODUCT_LINE_LABELS: Record<(typeof PRODUCT_LINES)[number], string> = {
  three_wheeler: "E-rickshaw / e-auto",
  two_wheeler: "Electric 2-wheeler",
  inverter_battery: "Inverter battery",
  inverter: "Inverter",
  solar: "Solar",
  ess_bess: "ESS / BESS",
};
export const DEALER_ROLES = ["oem", "dealer", "both", "unknown"] as const;
export const DISQUALIFIERS = [
  "none",
  "dont_call",
  "hostile",
  "not_interested",
  "call_dropped",
] as const;
export const LANGUAGES = ["hindi", "english", "hinglish", "unknown"] as const;
// What a requested callback is ABOUT — decides who makes it (callCategory.ts):
// general_info / none → the AI calls back; the commercial four → a person.
export const CALLBACK_TOPICS = [
  "none",
  "general_info",
  "pricing",
  "negotiation",
  "dealership",
  "purchase",
  // D8 — a problem with a battery / service he already has. Not a sales lead:
  // a person takes it, labelled Complaint, and nobody pitches.
  "complaint",
] as const;

export type YesNo = (typeof YES_NO)[number];
export type YesNoUnknown = (typeof YES_NO_UNKNOWN)[number];
export type DealerSegment = (typeof DEALER_SEGMENTS)[number];
export type ProductLine = (typeof PRODUCT_LINES)[number];
export type DealerRole = (typeof DEALER_ROLES)[number];
export type Disqualifier = (typeof DISQUALIFIERS)[number];
export type LanguageType = (typeof LANGUAGES)[number];
export type CallbackTopic = (typeof CALLBACK_TOPICS)[number];

// ── Schema ───────────────────────────────────────────────────────────────────

// A yes/no fact that defaults to "no" on any bad value — "if a signal is not
// clearly present, mark it no" (PDF §2).
const yesNo = z.enum(YES_NO).catch("no");
const evidenceStr = z.string().catch("");

export const QualificationSignalsSchema = z.object({
  // ── THE qualifying question (the band gate) ──
  // "Are you a lithium battery dealer?" — yes → Qualified (75, or 90 with
  // volume_shared), no → Disqualified, unknown (never answered) → Cold.
  lithium_dealer: z.enum(YES_NO_UNKNOWN).catch("unknown"),

  // ── Market relevance (D9/D10, qualification-2.2.0) ──
  // relevant_dealer = he deals in at least one PRODUCT_LINE. Together with
  // lithium_dealer it decides a lead-acid dealer: in our lines → Warm, outside
  // them → Disqualified (computeBand).
  relevant_dealer: yesNo,
  // Every line he deals in (several allowed); [] when none was stated.
  product_lines: z
    .array(z.string())
    .catch([])
    .transform((xs) =>
      xs.filter((x): x is ProductLine => (PRODUCT_LINES as readonly string[]).includes(x)),
    ),
  // Legacy single segment — read from old rows only, never asked for now.
  dealer_segment: z.enum(DEALER_SEGMENTS).optional().catch(undefined),
  dealer_role: z.enum(DEALER_ROLES).catch("unknown"), // context/routing only

  // ── The five INFO signals (info_signals_count = how many are "yes") ──
  battery_spec_shared: yesNo, // capacity / voltage / Ah / chemistry stated
  volume_shared: yesNo, // units per month — lifts a lithium "yes" from 75 to 90
  existing_financier_shared: yesNo, // names a financier/NBFC, or states none
  financing_need_expressed: yesNo, // needs financing / rising prices make it necessary
  financing_value_acknowledged: yesNo, // agrees financing would grow his business

  // ── Progression signals ──
  pitch_heard: yesNo, // stayed on the line through battery + finance pitch
  // callback_agreed = yes if he agreed to a follow-up — a PASSIVE "ok / theek
  // hai" to an AGENT-OFFERED callback COUNTS as yes (the qualifying event).
  callback_agreed: yesNo,

  // ── Callback detail (signals-2.2.0) — routing facts, no band impact on their
  // own. callback_at is the model's reading of the dealer's words as an IST
  // timestamp ("" when no time was named); callback_when keeps the words so a
  // reviewer can check it. Neither is trusted blindly — see callbackDueAt().
  callback_when: z.string().catch(""),
  callback_at: z.string().catch(""),
  callback_topic: z.enum(CALLBACK_TOPICS).catch("none"),
  // The dealer asked to speak to a person — a manager, "your senior", "someone
  // from the company". Routes the lead to the sales team.
  wants_human: yesNo,

  // ── EMI finance (signals-2.4.0) ──
  // He asked about / wants EMI finance on Trontek lithium batteries through an
  // NBFC partner (Bajaj Finserv etc.). Lifts the band one step (computeBand).
  // Merely naming the financier he already uses is existing_financier_shared.
  emi_finance_interest: yesNo,

  // ── Hard negative ──
  disqualifier: z.enum(DISQUALIFIERS).catch("none"),

  // ── Evidence (short quote/paraphrase per signal; "" when absent) ──
  evidence: z
    .object({
      lithium_dealer: evidenceStr,
      relevant_dealer: evidenceStr,
      battery_spec_shared: evidenceStr,
      volume_shared: evidenceStr,
      existing_financier_shared: evidenceStr,
      financing_need_expressed: evidenceStr,
      financing_value_acknowledged: evidenceStr,
      emi_finance_interest: evidenceStr,
      callback_agreed: evidenceStr,
    })
    .catch({
      lithium_dealer: "",
      relevant_dealer: "",
      battery_spec_shared: "",
      volume_shared: "",
      existing_financier_shared: "",
      financing_need_expressed: "",
      financing_value_acknowledged: "",
      emi_finance_interest: "",
      callback_agreed: "",
    }),

  language: z.enum(LANGUAGES).catch("unknown"),
  // One neutral sentence describing the call — feeds the drawer + sheet summary.
  call_summary: z.string().catch(""),
});

export type QualificationSignals = z.infer<typeof QualificationSignalsSchema>;

// Kept as an alias so the handful of generic importers (parser, analysis,
// feedback route) don't need to track the rename. The shape is the band model's.
export type IntentSignals = QualificationSignals;

// The FIVE info signals whose "yes" count is info_signals_count (0–5). This is
// the single source of truth for that set — the band engine and any UI count
// from here, never from a hand-copied list.
export const INFO_SIGNAL_KEYS = [
  "battery_spec_shared",
  "volume_shared",
  "existing_financier_shared",
  "financing_need_expressed",
  "financing_value_acknowledged",
] as const satisfies readonly (keyof QualificationSignals)[];

// The three FINANCING signals among the five — used by the optional tuning lever
// that requires ≥1 financing signal for the substance→Qualified path.
export const FINANCING_SIGNAL_KEYS = [
  "existing_financier_shared",
  "financing_need_expressed",
  "financing_value_acknowledged",
] as const satisfies readonly (keyof QualificationSignals)[];

/** Count how many of the five info signals the dealer disclosed (0–5). */
export function countInfoSignals(s: QualificationSignals): number {
  return INFO_SIGNAL_KEYS.reduce((n, k) => n + (s[k] === "yes" ? 1 : 0), 0);
}

/** True if the dealer disclosed at least one financing signal. */
export function hasFinancingSignal(s: QualificationSignals): boolean {
  return FINANCING_SIGNAL_KEYS.some((k) => s[k] === "yes");
}

// A neutral, all-"no" / all-"none" signal set. Used as a base for deep-merging
// partial LLM output and as a sentinel.
export const EMPTY_SIGNALS: QualificationSignals = QualificationSignalsSchema.parse({});
