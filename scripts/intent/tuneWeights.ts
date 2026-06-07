// Offline rubric tuner (Lever B of the learning loop).
//
//   npm run intent:tune-weights
//
// Because scoring is pure arithmetic over signals, we can search thousands of
// weight/threshold combinations against the golden set's cached signals with NO
// LLM calls. This does a coordinate-ascent search starting from the CURRENT
// weights, maximizing label accuracy (tie-break: minimize score MAE), and prints
// a PROPOSED diff. It does NOT edit any file — a human reviews the proposal,
// applies it to weights.ts / thresholds.ts, and bumps SCORING_VERSION.
//
// NOTE: the scorer below mirrors computeIntentScore.ts exactly (positive sum +
// negative caps + qualified gate + routing overrides). If you change the
// production formula, mirror it here too — a unit assertion in evalIntent keeps
// you honest by comparing this against the real scorer on the current config.

import {
  SIGNAL_WEIGHTS,
  LEVEL_FRACTION,
  TIMELINE_FRACTION,
  OBJECTION_FRACTION,
  NEGATIVE_CAPS,
  INTENT_THRESHOLDS,
  type IntentSignals,
  type LeadStatus,
} from "@/lib/ai/scoring";
import { readGolden, truthSignals, accuracy } from "./_lib";

interface Cfg {
  weights: { need: number; budget: number; engagement: number; curiosity: number; timeline: number; objection_quality: number };
  thresholds: { QUALIFIED: number; WARM: number; COLD: number };
}

const START: Cfg = {
  weights: { ...SIGNAL_WEIGHTS },
  thresholds: { ...INTENT_THRESHOLDS },
};

// Parametrized mirror of computeIntentScore + decideRoute → (score, label).
function scoreLabel(s: IntentSignals, cfg: Cfg): { score: number; label: LeadStatus } {
  const w = cfg.weights;
  const positive =
    Math.round(w.need * LEVEL_FRACTION[s.need.level]) +
    Math.round(w.budget * LEVEL_FRACTION[s.budget.level]) +
    Math.round(w.engagement * LEVEL_FRACTION[s.engagement.level]) +
    Math.round(w.curiosity * LEVEL_FRACTION[s.curiosity.level]) +
    Math.round(w.timeline * TIMELINE_FRACTION[s.timeline.level]) +
    Math.round(w.objection_quality * OBJECTION_FRACTION[s.objection_quality.level]);

  const n = s.negatives;
  let cap = 100;
  if (n.do_not_call) cap = Math.min(cap, NEGATIVE_CAPS.do_not_call);
  if (n.already_bought_competitor) cap = Math.min(cap, NEGATIVE_CAPS.already_bought_competitor);
  if (n.explicit_not_interested) cap = Math.min(cap, NEGATIVE_CAPS.explicit_not_interested);
  if (n.hostile) cap = Math.min(cap, NEGATIVE_CAPS.hostile);
  if (n.call_too_short) cap = Math.min(cap, NEGATIVE_CAPS.call_too_short);
  const score = Math.min(positive, cap);

  const qualifiedGate =
    score >= cfg.thresholds.QUALIFIED &&
    s.authority.level !== "not_decision_maker" &&
    !n.do_not_call &&
    !n.already_bought_competitor &&
    !n.explicit_not_interested;

  // Routing overrides (mirror decideRoute).
  if (n.do_not_call || n.explicit_not_interested || n.already_bought_competitor)
    return { score, label: "disqualified" };
  if (s.facts.callback_requested) return { score, label: "warm" };

  let label: LeadStatus;
  if (score >= cfg.thresholds.QUALIFIED) label = qualifiedGate ? "qualified" : "warm";
  else if (score >= cfg.thresholds.WARM) label = "warm";
  else if (score >= cfg.thresholds.COLD) label = "cold";
  else label = "disqualified";
  return { score, label };
}

type Case = { s: IntentSignals; label: LeadStatus; correctedScore: number | null };

function evalCfg(cases: Case[], cfg: Cfg) {
  const pairs = cases.map((c) => ({ truth: c.label, pred: scoreLabel(c.s, cfg).label }));
  const acc = accuracy(pairs);
  const maes = cases
    .filter((c) => c.correctedScore != null)
    .map((c) => Math.abs(scoreLabel(c.s, cfg).score - (c.correctedScore as number)));
  const mae = maes.length ? maes.reduce((a, b) => a + b, 0) / maes.length : 0;
  return { acc, mae };
}

function clone(cfg: Cfg): Cfg {
  return { weights: { ...cfg.weights }, thresholds: { ...cfg.thresholds } };
}

// Better = higher accuracy, then lower MAE.
function better(a: { acc: number; mae: number }, b: { acc: number; mae: number }): boolean {
  if (a.acc !== b.acc) return a.acc > b.acc;
  return a.mae < b.mae;
}

async function main() {
  // Optional `--source=prod|sandbox|both` (default both) to tune on a subset —
  // e.g. tune against production reality only.
  const sourceArg = (
    process.argv.slice(2).find((a) => a.startsWith("--source="))?.split("=")[1] ?? "both"
  ).toLowerCase();

  const golden = await readGolden();
  const cases = golden
    .filter((c) => sourceArg === "both" || (c.source ?? "unknown") === sourceArg)
    .map((c) => ({ s: truthSignals(c), label: c.label, correctedScore: c.correctedScore }))
    .filter((c): c is Case => c.s != null);

  if (cases.length === 0) {
    console.log(
      `No usable golden cases for source="${sourceArg}" (need signals). Run intent:export-golden first.`,
    );
    process.exit(0);
  }
  if (sourceArg !== "both") console.log(`Tuning on source="${sourceArg}" only.`);

  let best = clone(START);
  let bestScore = evalCfg(cases, best);
  const baseScore = bestScore;

  const weightKeys = Object.keys(START.weights) as Array<keyof Cfg["weights"]>;
  const thrKeys = Object.keys(START.thresholds) as Array<keyof Cfg["thresholds"]>;
  const deltas = [-5, -3, -2, -1, 1, 2, 3, 5];

  // Coordinate ascent: repeatedly try perturbing one knob, keep any improvement.
  for (let iter = 0; iter < 40; iter++) {
    let improved = false;
    for (const k of weightKeys) {
      for (const d of deltas) {
        const cand = clone(best);
        cand.weights[k] = Math.max(0, cand.weights[k] + d);
        const sc = evalCfg(cases, cand);
        if (better(sc, bestScore)) { best = cand; bestScore = sc; improved = true; }
      }
    }
    for (const k of thrKeys) {
      for (const d of deltas) {
        const cand = clone(best);
        cand.thresholds[k] = Math.max(0, Math.min(100, cand.thresholds[k] + d));
        // keep ordering sane
        if (cand.thresholds.COLD <= cand.thresholds.WARM && cand.thresholds.WARM <= cand.thresholds.QUALIFIED) {
          const sc = evalCfg(cases, cand);
          if (better(sc, bestScore)) { best = cand; bestScore = sc; improved = true; }
        }
      }
    }
    if (!improved) break;
  }

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log(`\nWeight tuner — ${cases.length} golden case(s)\n`);
  console.log(`Baseline (current weights): accuracy ${pct(baseScore.acc)}, MAE ${baseScore.mae.toFixed(1)}`);
  console.log(`Best found:                 accuracy ${pct(bestScore.acc)}, MAE ${bestScore.mae.toFixed(1)}`);

  if (!better(bestScore, baseScore)) {
    console.log(`\n✓ Current weights are already optimal on this golden set — no change proposed.`);
    process.exit(0);
  }

  console.log(`\nPROPOSED CHANGES (review, then apply by hand + bump SCORING_VERSION):\n`);
  const wsumNew = Object.values(best.weights).reduce((a, b) => a + b, 0);
  for (const k of weightKeys) {
    if (best.weights[k] !== START.weights[k])
      console.log(`  SIGNAL_WEIGHTS.${k}: ${START.weights[k]} → ${best.weights[k]}`);
  }
  for (const k of thrKeys) {
    if (best.thresholds[k] !== START.thresholds[k])
      console.log(`  INTENT_THRESHOLDS.${k}: ${START.thresholds[k]} → ${best.thresholds[k]}`);
  }
  if (wsumNew !== 100)
    console.log(`\n  ⚠ proposed SIGNAL_WEIGHTS sum to ${wsumNew} (was 100). The score is "% of an`);
  console.log(`    ideal buyer" only when they sum to 100 — re-normalize if you keep that property.`);
  console.log(`\n  ⚠ Small golden sets overfit. Re-run \`npm run eval:intent\` after applying,`);
  console.log(`    and don't ship a change backed by only a handful of corrections.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
