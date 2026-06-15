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
export const DEALER_SEGMENTS = [
  "battery",
  "e_rickshaw",
  "e_2w",
  "multiple",
  "none",
] as const;
export const DEALER_ROLES = ["oem", "dealer", "both", "unknown"] as const;
export const DISQUALIFIERS = [
  "none",
  "dont_call",
  "hostile",
  "not_interested",
  "call_dropped",
] as const;
export const LANGUAGES = ["hindi", "english", "hinglish", "unknown"] as const;

export type YesNo = (typeof YES_NO)[number];
export type DealerSegment = (typeof DEALER_SEGMENTS)[number];
export type DealerRole = (typeof DEALER_ROLES)[number];
export type Disqualifier = (typeof DISQUALIFIERS)[number];
export type LanguageType = (typeof LANGUAGES)[number];

// ── Schema ───────────────────────────────────────────────────────────────────

// A yes/no fact that defaults to "no" on any bad value — "if a signal is not
// clearly present, mark it no" (PDF §2).
const yesNo = z.enum(YES_NO).catch("no");
const evidenceStr = z.string().catch("");

export const QualificationSignalsSchema = z.object({
  // ── Market relevance (gate) + routing context ──
  // relevant_dealer = no → Disqualified, regardless of anything else.
  relevant_dealer: yesNo,
  dealer_segment: z.enum(DEALER_SEGMENTS).catch("none"), // context/routing only
  dealer_role: z.enum(DEALER_ROLES).catch("unknown"), // context/routing only

  // ── The five INFO signals (info_signals_count = how many are "yes") ──
  battery_spec_shared: yesNo, // capacity / voltage / Ah / chemistry stated
  volume_shared: yesNo, // units per month or business volume / turnover
  existing_financier_shared: yesNo, // names a financier/NBFC, or states none
  financing_need_expressed: yesNo, // needs financing / rising prices make it necessary
  financing_value_acknowledged: yesNo, // agrees financing would grow his business

  // ── Progression signals ──
  pitch_heard: yesNo, // stayed on the line through battery + finance pitch
  // callback_agreed = yes if he agreed to a follow-up — a PASSIVE "ok / theek
  // hai" to an AGENT-OFFERED callback COUNTS as yes (the qualifying event).
  callback_agreed: yesNo,

  // ── Hard negative ──
  disqualifier: z.enum(DISQUALIFIERS).catch("none"),

  // ── Evidence (short quote/paraphrase per signal; "" when absent) ──
  evidence: z
    .object({
      relevant_dealer: evidenceStr,
      battery_spec_shared: evidenceStr,
      volume_shared: evidenceStr,
      existing_financier_shared: evidenceStr,
      financing_need_expressed: evidenceStr,
      financing_value_acknowledged: evidenceStr,
      callback_agreed: evidenceStr,
    })
    .catch({
      relevant_dealer: "",
      battery_spec_shared: "",
      volume_shared: "",
      existing_financier_shared: "",
      financing_need_expressed: "",
      financing_value_acknowledged: "",
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
