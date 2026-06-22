-- E-173 — EMI Tracker: partial payments + manual-collection metadata
--
-- Adds support for partial EMI collections (e.g. a ₹5,250 EMI where ₹3,000 is
-- paid leaves ₹2,250 due) and enriches the attempt ledger with the metadata a
-- manual collection needs: a human-entered reference, an uploaded receipt URL,
-- the actual collection date, a note, and who recorded it.
--
-- Partial payments are modelled with a single cumulative column,
-- emi_schedules.amount_paid. No new lifecycle status: an installment stays
-- scheduled/overdue/missed until amount_paid >= amount, then flips to
-- paid/paid_late. "Partially paid" is a DERIVED UI state (0 < amount_paid <
-- amount), so the aging cron and auto-debit selection (which key off
-- scheduled/overdue/missed) are untouched.
--
-- All additive + idempotent — safe to re-run. Mirrored in src/lib/db/schema.ts.

-- Cumulative amount collected against an installment.
ALTER TABLE emi_schedules
  ADD COLUMN IF NOT EXISTS amount_paid numeric(12,2) NOT NULL DEFAULT 0;

-- Manual-collection metadata on the per-attempt event ledger.
ALTER TABLE emi_payment_attempts
  ADD COLUMN IF NOT EXISTS reference_no varchar(80);
ALTER TABLE emi_payment_attempts
  ADD COLUMN IF NOT EXISTS document_url text;
ALTER TABLE emi_payment_attempts
  ADD COLUMN IF NOT EXISTS collected_at timestamptz;
ALTER TABLE emi_payment_attempts
  ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE emi_payment_attempts
  ADD COLUMN IF NOT EXISTS actor_user_id uuid;

-- channel gains manual values: 'upi' | 'bank_transfer' | 'cheque' | 'qr'
-- alongside the existing 'enach' | 'upi_link' | 'cash'. No DB CHECK exists, so
-- there is nothing to alter — documented here only.

-- Backfill: fully-paid installments are considered fully collected.
UPDATE emi_schedules
SET amount_paid = amount
WHERE status IN ('paid', 'paid_late')
  AND amount IS NOT NULL
  AND amount_paid = 0;
