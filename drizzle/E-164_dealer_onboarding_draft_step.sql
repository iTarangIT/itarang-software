-- E-164: Resumable dealer onboarding — remember which wizard step a draft is on.
--
-- The onboarding wizard now autosaves each in-progress dealer to its own
-- dealer_onboarding_applications row (onboarding_status='draft') so internal
-- staff can close the laptop, switch between dealers, and resume later. To
-- resume on the exact step the user left (instead of restarting at step 1), we
-- persist the last wizard step on the draft row.
--
-- (Originally drafted as E-160, renumbered to E-164: E-160 was already taken by
-- E-160_nbfc_wallet_funds_provider.sql, and E-161..E-163 also exist.)
--
-- Strictly additive + idempotent. Re-running this file is a no-op.

ALTER TABLE dealer_onboarding_applications
  ADD COLUMN IF NOT EXISTS draft_step integer DEFAULT 1;
