-- =============================================================================
-- E-397 — Won means paid (25 Nov 2026 task list, "Quotations and dealer
-- accounts", items 6 + 7).
--
-- A lead's Won now means the deal closed and the dealer PAID — not a Hot lead
-- and not a submitted onboarding (the system no longer moves a lead to Won when
-- onboarding is submitted; decided 25 Nov). Mark Won asks for the payment
-- reference (UTR / cheque / transaction number), stored here:
--
--   won_payment_reference    what the rep typed on Mark Won.
--   won_payment_recorded_at  when it was recorded.
--
-- NOT mirrored in schema.ts — raw SQL behind a probe
-- (src/lib/leads/markConverted.ts hasWonPaymentColumns). Before this file is
-- applied, Mark Won still asks for the reference and writes it into the
-- status-change note on the lead's timeline; the column stays empty.
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

DO $do$
BEGIN
    ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS won_payment_reference text;
    ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS won_payment_recorded_at timestamptz;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: dealer_leads missing';
END;
$do$;
