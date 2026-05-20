-- E-125_cost_currency_default_inr.sql
--
-- Cost is now stored in ai_call_logs.*_cost_cents as INR minor units (paise)
-- for every provider. ElevenLabs bills this account in rupees (credits -> INR
-- directly); Bolna's USD figures are converted to INR once, at fetch time
-- (see src/lib/ai/*/fetchCallCost.ts). The cost_currency column therefore
-- defaults to 'INR' going forward.
--
-- Existing rows are re-based to INR by the cost re-sync (the
-- sync-elevenlabs-conversations script for ElevenLabs + a one-off Bolna
-- UPDATE), not by this migration -- so this file only adjusts the column
-- default for future inserts.
--
-- Additive + idempotent: ALTER COLUMN ... SET DEFAULT is naturally a no-op on
-- re-run.

ALTER TABLE ai_call_logs ALTER COLUMN cost_currency SET DEFAULT 'INR';
