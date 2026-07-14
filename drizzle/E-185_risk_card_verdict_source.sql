-- E-185 — Honest risk verdicts.
--
-- Two problems this fixes:
--
--   1. Every failure path in the risk engine wrote severity='ok'. A sandbox
--      crash, an unparseable LLM response, an unreachable IoT DB — all rendered
--      as a green "OK" card, indistinguishable from "we tested this and the
--      portfolio is fine". The severity vocabulary now also allows
--      'inconclusive' (could not test) and 'error' (the test blew up).
--
--   2. When the Python sandbox was down — the default, since NBFC_SANDBOX_URL
--      has never been configured — the engine asked gpt-4o-mini to *state* the
--      severity and the affected/total counts, and those landed in the same
--      columns as hand-computed ones with nothing to tell them apart.
--      verdict_source records who actually did the arithmetic.
--
-- Additive and idempotent. No existing row changes severity; only the new
-- verdict_source column is backfilled.

ALTER TABLE risk_card_runs
  ADD COLUMN IF NOT EXISTS verdict_source varchar(16);

COMMENT ON COLUMN risk_card_runs.verdict_source IS
  'Who computed severity/counts: hand_coded | sandbox | none | legacy_llm. NULL only for rows not yet backfilled.';

-- Backfill history honestly.
--   • llm_model = 'hand-coded'  → a TS evaluator did the arithmetic.
--   • everything else pre-E-185 → the LLM may have stated the numbers itself.
--     We cannot retroactively tell an LLM-invented count from a sandbox-computed
--     one (the sandbox was never configured, so in practice none are), so these
--     are marked legacy_llm and the UI flags them as unverified rather than
--     silently presenting them as measurements.
UPDATE risk_card_runs
   SET verdict_source = 'hand_coded'
 WHERE verdict_source IS NULL
   AND llm_model = 'hand-coded';

UPDATE risk_card_runs
   SET verdict_source = 'legacy_llm'
 WHERE verdict_source IS NULL;

-- Lets the Risk page filter/count by provenance without a seq scan once the
-- table grows past a few runs per tenant.
CREATE INDEX IF NOT EXISTS risk_card_runs_verdict_source_idx
  ON risk_card_runs (verdict_source);
