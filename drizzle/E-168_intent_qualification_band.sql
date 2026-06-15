-- E-168 — Intent Qualification band model
-- (docs/intent_docs/intent_score.pdf). Replaces the weighted intent-score model
-- with a deterministic yes/no-signal band: each completed AI call is classified
-- into Qualified | Warm | Cold | Disqualified, computed in code from factual
-- signals. The band's lead_score (90/60/30/0) keeps riding in the existing
-- numeric final_intent_score / intent_score, so no threshold/sort consumer
-- changes — these columns add the band label, the dropped-call status, and the
-- disclosed-facts count that orders the Qualified queue.
--
-- Strictly additive. Idempotent — safe to re-run (no-op on second apply).

-- ── dealer_leads: per-lead headline band state ──
ALTER TABLE dealer_leads
  ADD COLUMN IF NOT EXISTS intent_band varchar(20);
ALTER TABLE dealer_leads
  ADD COLUMN IF NOT EXISTS call_status varchar(20);
ALTER TABLE dealer_leads
  ADD COLUMN IF NOT EXISTS info_signals_count integer;

-- ── ai_call_logs: per-call band audit ──
ALTER TABLE ai_call_logs
  ADD COLUMN IF NOT EXISTS band varchar(20);
ALTER TABLE ai_call_logs
  ADD COLUMN IF NOT EXISTS call_status varchar(20);
ALTER TABLE ai_call_logs
  ADD COLUMN IF NOT EXISTS info_signals_count integer;

-- Orders the Qualified inside-sales queue by facts disclosed (more = higher
-- priority). Partial index keeps it small — only ranked rows carry a count.
CREATE INDEX IF NOT EXISTS dealer_leads_info_signals_count_idx
  ON dealer_leads (info_signals_count DESC)
  WHERE info_signals_count IS NOT NULL;
