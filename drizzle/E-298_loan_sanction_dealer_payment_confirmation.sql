-- =============================================================================
-- E-298 — Dealer confirms the loan money actually reached them (2026-09-17,
--         Pile B item 11).
-- =============================================================================
-- `confirm-dispatch.ts` flips loan_sanctions.status to 'disbursed' the moment
-- the dealer confirms dispatch, but nothing ever recorded whether the lender's
-- payout reached the DEALER's bank. (`dealer_approved*` means "dealer approved
-- dispatch", not "dealer was paid".)
--
--   dealer_payment_status       NULL (never asked) | pending | received | not_received
--   dealer_payment_confirmed_at when the dealer answered
--   dealer_payment_confirmed_by users.id (portal) or 'whatsapp:<phone>' (chat)
--   dealer_payment_utr          optional bank reference the dealer typed
--   dealer_payment_amount       optional amount the dealer says arrived
--   dealer_payment_remarks      optional free text (esp. on not_received)
--   dealer_payment_reminded_at  stamped by the one-shot 48h reminder sweep
--
-- Additive and idempotent. No backfill: rows disbursed before this migration
-- stay NULL ("not asked") and never get a prompt or a reminder.
-- =============================================================================

DO $do$
BEGIN
  ALTER TABLE loan_sanctions
    ADD COLUMN IF NOT EXISTS dealer_payment_status varchar(20),
    ADD COLUMN IF NOT EXISTS dealer_payment_confirmed_at timestamptz,
    ADD COLUMN IF NOT EXISTS dealer_payment_confirmed_by text,
    ADD COLUMN IF NOT EXISTS dealer_payment_utr varchar(64),
    ADD COLUMN IF NOT EXISTS dealer_payment_amount numeric(14,2),
    ADD COLUMN IF NOT EXISTS dealer_payment_remarks text,
    ADD COLUMN IF NOT EXISTS dealer_payment_reminded_at timestamptz;

  -- The reminder sweep and the dealer "pending" badge only ever look at
  -- pending rows — a tiny slice of the table.
  CREATE INDEX IF NOT EXISTS loan_sanctions_dealer_payment_pending_idx
    ON loan_sanctions (disbursed_at)
    WHERE dealer_payment_status = 'pending';

  COMMENT ON COLUMN loan_sanctions.dealer_payment_status IS
    'E-298: dealer payment confirmation — NULL (not asked) | pending | received | not_received.';
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'E-298 skip: loan_sanctions does not exist on this database';
END;
$do$;
