-- E-159: Intent-score human feedback — the "this score is wrong" correction.
--
-- A reviewer corrects an AI intent score from the transcript drawer. Each row
-- snapshots what the AI produced (original_intent_score + original_signals +
-- scoring_version) and records the human ground truth (corrected_status, and
-- optionally corrected_score / corrected_signals). These rows are the benchmark
-- / golden set replayed by the eval harness (scripts/intent) and consumed by the
-- calibration + weight-tuning learning levers.
--
-- Strictly additive + idempotent. Re-running this file is a no-op.

CREATE TABLE IF NOT EXISTS intent_score_feedback (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id                varchar(255) NOT NULL,
  lead_id                varchar(255),
  scoring_version        varchar(20),
  original_intent_score  integer,
  original_signals       jsonb,
  corrected_status       varchar(20) NOT NULL,
  corrected_score        integer,
  corrected_signals      jsonb,
  reviewer_note          text,
  reviewed_by            uuid,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS intent_score_feedback_call_id_idx
  ON intent_score_feedback (call_id);
CREATE INDEX IF NOT EXISTS intent_score_feedback_lead_id_idx
  ON intent_score_feedback (lead_id);
CREATE INDEX IF NOT EXISTS intent_score_feedback_created_at_idx
  ON intent_score_feedback (created_at);
