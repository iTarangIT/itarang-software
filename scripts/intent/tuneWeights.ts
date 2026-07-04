// OBSOLETE as of the intent-qualification band model (E-168,
// docs/intent_docs/intent_score.pdf). The weighted intent-score model this
// tuner optimized — positive weights + negative caps + a numeric qualified gate
// — no longer exists. The band model is a deterministic yes/no rule with no
// weights to search; its ONLY lever is the info-signals threshold
// (INFO_SIGNALS_QUALIFY_THRESHOLD in src/lib/ai/scoring/computeBand.ts) plus the
// optional REQUIRE_FINANCING_SIGNAL_FOR_SUBSTANCE flag. Tune those by hand and
// bump SCORING_VERSION — there is nothing to optimize offline.
//
// `npm run eval:intent` still works: it replays human band corrections through
// computeBand to measure label accuracy (the regression gate).

console.error(
  [
    "✗ intent:tune-weights is obsolete.",
    "",
    "  The weighted intent-score model was replaced by the deterministic band",
    "  model (docs/intent_docs/intent_score.pdf). There are no weights to tune.",
    "  The only lever is INFO_SIGNALS_QUALIFY_THRESHOLD (default 3) in",
    "  src/lib/ai/scoring/computeBand.ts — change it by hand, bump SCORING_VERSION,",
    "  then watch `npm run eval:intent`.",
  ].join("\n"),
);
process.exit(1);
