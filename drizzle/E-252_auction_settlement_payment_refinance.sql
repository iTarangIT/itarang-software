-- E-252 — auction settlement: payment capture and the refinance link.
--
-- WHAT THIS UNBLOCKS
--   `auction_settlements` has carried a three-state ladder since E-039 —
--   payment_pending → in_transit → delivered — and nothing in it records that
--   money ever moved. The seller flips the status by hand; no reference, no
--   timestamp, no provider. A winner who never pays leaves the row in
--   payment_pending for ever with no way to say so and no way to re-list.
--
--   E-232 deliberately stopped short of these columns and said so, both in the
--   migration and in schema.ts:
--       "payment_ref and refinance_loan_id are deliberately NOT added here —
--        they belong to Phase 6, which is out of scope."
--   This is that phase.
--
-- WHY varchar AND NOT uuid
--   `refinance_loan_id` points at `loan_sanctions.id`, which is
--   `character varying`, not uuid — the same trap E-232 had to ship a
--   self-correction block for after an earlier draft typed `winner_dealer_id`
--   as uuid against `accounts.id` values like 'ACC-ITARANG-20260409-971'.
--
-- Strictly additive and idempotent. Nothing is dropped, nothing is narrowed,
-- no existing column changes type. Re-running this file is a no-op.
--
-- Apply order: sandbox (database-1) first, verify against information_schema,
-- then production (database-2). Paste into the SQL editor. Never `db:push`.

BEGIN;

ALTER TABLE auction_settlements
  ADD COLUMN IF NOT EXISTS payment_ref       varchar(120),
  ADD COLUMN IF NOT EXISTS payment_provider  varchar(24),
  ADD COLUMN IF NOT EXISTS paid_at           timestamptz,
  ADD COLUMN IF NOT EXISTS refinance_loan_id varchar(255),
  ADD COLUMN IF NOT EXISTS failure_reason    text;

-- Looked up by the payment webhook, which arrives knowing only the provider's
-- own id, and by the servicing view that walks back from a loan to the auction
-- that created it.
CREATE INDEX IF NOT EXISTS auction_settlements_payment_ref_idx
  ON auction_settlements (payment_ref);
CREATE INDEX IF NOT EXISTS auction_settlements_refinance_loan_idx
  ON auction_settlements (refinance_loan_id);

COMMENT ON COLUMN auction_settlements.payment_ref IS
  'Provider payment/order id (Razorpay). NULL until money is captured. The
   status column alone never proved payment: payment_pending -> in_transit was
   a manual flip by the seller with nothing behind it.';

COMMENT ON COLUMN auction_settlements.payment_provider IS
  'Which rail took the money: razorpay | offline. "offline" is an explicit,
   audited admin action for a bank transfer settled outside the app — not a
   silent bypass.';

COMMENT ON COLUMN auction_settlements.paid_at IS
  'When capture was confirmed. The gate on advancing to in_transit.';

COMMENT ON COLUMN auction_settlements.refinance_loan_id IS
  'loan_sanctions.id raised when auction_type = cash_refinance. varchar(255),
   not uuid: loan_sanctions.id is character varying.';

COMMENT ON COLUMN auction_settlements.failure_reason IS
  'Why a settlement was abandoned — unpaid past SLA, withdrawn, disputed. Set
   when the batteries are released back to ready for re-listing.';

COMMIT;
