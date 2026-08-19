// (B) BANDING — deterministic, pure, version-tagged. The LLM never bands; this
// function owns the rule. Given fixed signals the output is 100% reproducible
// and every band traces to the signals behind it
// (docs/intent_docs/intent_score.pdf §3). The band rule is the SINGLE point of
// change — tune the two levers below, nothing else.

import {
  countInfoSignals,
  hasFinancingSignal,
  type QualificationSignals,
} from "./signals";
import { SCORING_VERSION } from "./version";

// ── Tuning levers (PDF §5 "Tuning principle") ────────────────────────────────
// Ship the threshold of 3 first, watch conversion, then tune. The band rule is
// the one place to change.
export const INFO_SIGNALS_QUALIFY_THRESHOLD = 3;
// Lever 1: when true, the substance→Qualified path ALSO requires ≥1 financing
// signal, so purely operational disclosures (spec + volume only) land Warm.
export const REQUIRE_FINANCING_SIGNAL_FOR_SUBSTANCE = false;

export type Band = "Qualified" | "Warm" | "Cold" | "Disqualified";
export type CallStatus = "complete" | "dropped_partial" | "dropped_empty";
export type InterestLevel = "hot" | "warm" | "cold";
export type BandAction =
  | "push_to_crm"
  | "schedule_call"
  | "follow_up"
  | "stop"
  | "auto_retry";

// CRM handoff mapping (PDF §4). lead_score is carried in the existing numeric
// intent_score field so every downstream threshold/bucket/sort keeps working
// (90 ≥ 75 → hot, 60 ≥ 45 → warm, 30 ≥ 20 → cold).
const BAND_LEAD_SCORE: Record<Band, number> = {
  Qualified: 90,
  Warm: 60,
  Cold: 30,
  Disqualified: 0,
};
const BAND_INTEREST_LEVEL: Record<Band, InterestLevel | null> = {
  Qualified: "hot",
  Warm: "warm",
  Cold: "cold",
  Disqualified: null,
};
const BAND_ACTION: Record<Band, BandAction> = {
  Qualified: "push_to_crm",
  Warm: "schedule_call",
  Cold: "follow_up",
  Disqualified: "stop",
};

/**
 * What a band means downstream: its numeric lead_score, its CRM interest level,
 * and the action it routes to.
 *
 * Exported so the HUMAN OVERRIDE reads the SAME three tables the AI path does.
 * When a reviewer corrects a call to Warm, the lead must land on exactly the
 * score and interest level an AI-produced Warm would have — otherwise a
 * corrected lead and an AI-scored lead of the same band sort differently in
 * every queue, and any future edit to BAND_LEAD_SCORE fixes only one of them.
 * The maps stay private; this is the only way to read them.
 */
export function bandOutcome(band: Band): {
  lead_score: number;
  interest_level: InterestLevel | null;
  action: BandAction;
} {
  return {
    lead_score: BAND_LEAD_SCORE[band],
    interest_level: BAND_INTEREST_LEVEL[band],
    action: BAND_ACTION[band],
  };
}

// One audit row per decision-relevant signal — a truthful yes/no checklist (not
// an additive score). `present` is the fact; `info` flags the five that feed
// info_signals_count. Persisted to ai_call_logs.score_breakdown and rendered by
// the drawer.
export interface SignalLine {
  signal: string; // machine key
  label: string; // human label
  present: boolean; // the dealer disclosed/agreed it
  info: boolean; // one of the five info signals
  evidence: string;
}

export interface BandResult {
  band: Band | null; // null only for dropped_empty (no band written)
  call_status: CallStatus;
  info_signals_count: number; // 0..5 — also the Qualified-queue sort key
  interest_level: InterestLevel | null;
  lead_score: number; // 90 / 60 / 30 / 0
  action: BandAction;
  // Did the latest call hard-negate the lead? (drives demotion in leadStore)
  hard_negative: boolean;
  score_breakdown: SignalLine[];
  scoring_version: string;
}

const INFO_LABELS: Record<string, string> = {
  battery_spec_shared: "Battery spec shared",
  volume_shared: "Volume shared",
  existing_financier_shared: "Existing financier shared",
  financing_need_expressed: "Financing need expressed",
  financing_value_acknowledged: "Financing value acknowledged",
};

function buildBreakdown(s: QualificationSignals): SignalLine[] {
  const lines: SignalLine[] = [
    {
      signal: "relevant_dealer",
      label: "Relevant dealer",
      present: s.relevant_dealer === "yes",
      info: false,
      evidence: s.evidence.relevant_dealer,
    },
  ];
  for (const key of Object.keys(INFO_LABELS)) {
    const k = key as keyof QualificationSignals;
    lines.push({
      signal: key,
      label: INFO_LABELS[key],
      present: s[k] === "yes",
      info: true,
      evidence: (s.evidence as Record<string, string>)[key] ?? "",
    });
  }
  lines.push(
    {
      signal: "pitch_heard",
      label: "Pitch heard",
      present: s.pitch_heard === "yes",
      info: false,
      evidence: "",
    },
    {
      signal: "callback_agreed",
      label: "Callback agreed",
      present: s.callback_agreed === "yes",
      info: false,
      evidence: s.evidence.callback_agreed,
    },
  );
  if (s.disqualifier !== "none") {
    lines.push({
      signal: `disqualifier:${s.disqualifier}`,
      label: `Disqualifier — ${s.disqualifier.replace(/_/g, " ")}`,
      present: true,
      info: false,
      evidence: "",
    });
  }
  return lines;
}

const HARD_DISQUALIFIERS = new Set(["dont_call", "hostile", "not_interested"]);

export function computeBand(signals: QualificationSignals): BandResult {
  const info = countInfoSignals(signals);
  const callbackYes = signals.callback_agreed === "yes";
  const breakdown = buildBreakdown(signals);

  // ── Call status — a dropped call only voids the lead if NOTHING was captured
  let call_status: CallStatus;
  if (signals.disqualifier === "call_dropped") {
    if (info === 0 && !callbackYes) {
      // dropped_empty: no band written, auto-retry. Not a hard-negative — the
      // lead is simply untouched (leadStore keeps any prior band).
      return {
        band: null,
        call_status: "dropped_empty",
        info_signals_count: 0,
        interest_level: null,
        lead_score: 0,
        action: "auto_retry",
        hard_negative: false,
        score_breakdown: breakdown,
        scoring_version: SCORING_VERSION,
      };
    }
    call_status = "dropped_partial"; // substance captured before the drop
  } else {
    call_status = "complete";
  }

  // ── Band — top rule wins (runs for complete AND dropped_partial calls) ──
  let band: Band;
  if (signals.relevant_dealer === "no") {
    band = "Disqualified"; // not in our market
  } else if (HARD_DISQUALIFIERS.has(signals.disqualifier)) {
    band = "Disqualified";
  } else if (callbackYes || qualifiesOnSubstance(signals, info)) {
    band = "Qualified"; // commitment OR enough disclosed substance
  } else if (info >= 1) {
    band = "Warm";
  } else {
    band = "Cold"; // heard pitch, disclosed nothing
  }

  const hard_negative =
    signals.relevant_dealer === "no" || HARD_DISQUALIFIERS.has(signals.disqualifier);

  return {
    band,
    call_status,
    info_signals_count: info,
    interest_level: BAND_INTEREST_LEVEL[band],
    lead_score: BAND_LEAD_SCORE[band],
    action: BAND_ACTION[band],
    hard_negative,
    score_breakdown: breakdown,
    scoring_version: SCORING_VERSION,
  };
}

// The substance path to Qualified: enough info signals, and (when the optional
// lever is on) at least one of them is a financing signal.
function qualifiesOnSubstance(s: QualificationSignals, info: number): boolean {
  if (info < INFO_SIGNALS_QUALIFY_THRESHOLD) return false;
  if (REQUIRE_FINANCING_SIGNAL_FOR_SUBSTANCE && !hasFinancingSignal(s)) return false;
  return true;
}
