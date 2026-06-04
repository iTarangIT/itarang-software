-- E-158: Auditable intent scoring — persist the scoring version, raw extracted
-- signals, and the truthful per-point breakdown alongside each AI call.
--
-- Strictly additive + idempotent. Re-running this file is a no-op.
-- The deterministic scoring engine (src/lib/ai/scoring) writes:
--   ai_call_logs.scoring_version  — which weight table produced intent_score
--   ai_call_logs.signals          — the LLM-extracted BANT/quality/negative signals
--   ai_call_logs.score_breakdown  — contributions that SUM to intent_score
--
-- No new status enum is required: dealer_leads.current_status is plain text, so
-- the new "needs_review" value (set on analysis failure) needs no DDL.

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ai_call_logs') THEN
    RAISE NOTICE 'ai_call_logs table missing; skipping E-158';
    RETURN;
  END IF;

  ALTER TABLE ai_call_logs ADD COLUMN IF NOT EXISTS scoring_version varchar(20);
  ALTER TABLE ai_call_logs ADD COLUMN IF NOT EXISTS signals jsonb;
  ALTER TABLE ai_call_logs ADD COLUMN IF NOT EXISTS score_breakdown jsonb;
END
$do$;
