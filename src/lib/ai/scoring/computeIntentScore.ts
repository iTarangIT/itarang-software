// (B) SCORING — deterministic, pure, version-tagged. The LLM never produces the
// number; this function owns the arithmetic. Given fixed signals the output is
// 100% reproducible and every point traces to a signal (the breakdown SUMS to
// the score), so the UI breakdown is truthful and the weights are tunable in one
// place (weights.ts).

import type { IntentSignals } from "./signals";
import {
  SIGNAL_WEIGHTS,
  LEVEL_FRACTION,
  TIMELINE_FRACTION,
  OBJECTION_FRACTION,
  NEGATIVE_CAPS,
} from "./weights";
import { INTENT_THRESHOLDS } from "./thresholds";
import { SCORING_VERSION } from "./version";

export interface ScoreContribution {
  signal: string; // machine key (e.g. "need", "cap:do_not_call")
  label: string; // human label for the UI
  contribution: number; // points; negative for a cap line
  evidence: string;
}

export interface ScoreResult {
  intent_score: number; // 0..100 integer
  score_breakdown: ScoreContribution[]; // contributions sum EXACTLY to intent_score
  qualified_gate: boolean; // yes/no, separate from the numeric rank
  scoring_version: string;
}

const NEGATIVE_LABELS: Record<keyof typeof NEGATIVE_CAPS, string> = {
  do_not_call: "Do-not-call",
  already_bought_competitor: "Bought competitor",
  explicit_not_interested: "Not interested",
  hostile: "Hostile/abusive",
  call_too_short: "Call cut short",
};

export function computeIntentScore(signals: IntentSignals): ScoreResult {
  // ── Positive contributions (each rounded; together they cannot exceed 100) ──
  const need = Math.round(SIGNAL_WEIGHTS.need * LEVEL_FRACTION[signals.need.level]);
  const budget = Math.round(SIGNAL_WEIGHTS.budget * LEVEL_FRACTION[signals.budget.level]);
  const engagement = Math.round(
    SIGNAL_WEIGHTS.engagement * LEVEL_FRACTION[signals.engagement.level],
  );
  const curiosity = Math.round(
    SIGNAL_WEIGHTS.curiosity * LEVEL_FRACTION[signals.curiosity.level],
  );
  const timeline = Math.round(
    SIGNAL_WEIGHTS.timeline * TIMELINE_FRACTION[signals.timeline.level],
  );
  const objection = Math.round(
    SIGNAL_WEIGHTS.objection_quality * OBJECTION_FRACTION[signals.objection_quality.level],
  );

  const score_breakdown: ScoreContribution[] = [
    { signal: "need", label: "Need", contribution: need, evidence: signals.need.evidence },
    {
      signal: "budget",
      label: "Budget / Financing",
      contribution: budget,
      evidence: signals.budget.evidence,
    },
    {
      signal: "engagement",
      label: "Engagement",
      contribution: engagement,
      evidence: signals.engagement.evidence,
    },
    {
      signal: "curiosity",
      label: "Curiosity",
      contribution: curiosity,
      evidence: signals.curiosity.evidence,
    },
    {
      signal: "timeline",
      label: "Timeline",
      contribution: timeline,
      evidence: signals.timeline.evidence,
    },
    {
      signal: "objection_quality",
      label: "Objection Quality",
      contribution: objection,
      evidence: signals.objection_quality.evidence,
    },
  ];

  const positiveSum = need + budget + engagement + curiosity + timeline + objection;

  // ── Negative caps — the lowest applicable cap wins ─────────────────────────
  const negs = signals.negatives;
  let cap = 100;
  let capReason: keyof typeof NEGATIVE_CAPS | null = null;
  const applyCap = (active: boolean, value: number, reason: keyof typeof NEGATIVE_CAPS) => {
    if (active && value < cap) {
      cap = value;
      capReason = reason;
    }
  };
  applyCap(negs.do_not_call, NEGATIVE_CAPS.do_not_call, "do_not_call");
  applyCap(
    negs.already_bought_competitor,
    NEGATIVE_CAPS.already_bought_competitor,
    "already_bought_competitor",
  );
  applyCap(
    negs.explicit_not_interested,
    NEGATIVE_CAPS.explicit_not_interested,
    "explicit_not_interested",
  );
  applyCap(negs.hostile, NEGATIVE_CAPS.hostile, "hostile");
  applyCap(negs.call_too_short, NEGATIVE_CAPS.call_too_short, "call_too_short");

  let intent_score = positiveSum;
  if (capReason !== null && cap < positiveSum) {
    const reason = capReason as keyof typeof NEGATIVE_CAPS;
    // The cap line absorbs the reduction so the breakdown still SUMS to the
    // (capped) score exactly.
    score_breakdown.push({
      signal: `cap:${reason}`,
      label: `${NEGATIVE_LABELS[reason]} (cap ${NEGATIVE_CAPS[reason]})`,
      contribution: cap - positiveSum,
      evidence: reason.replace(/_/g, " "),
    });
    intent_score = cap;
  }

  // ── Hard qualification gate — separate yes/no, NOT the numeric rank ─────────
  const qualified_gate =
    intent_score >= INTENT_THRESHOLDS.QUALIFIED &&
    signals.authority.level !== "not_decision_maker" &&
    !negs.do_not_call &&
    !negs.already_bought_competitor &&
    !negs.explicit_not_interested;

  return { intent_score, score_breakdown, qualified_gate, scoring_version: SCORING_VERSION };
}
