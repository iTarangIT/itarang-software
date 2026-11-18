-- migration-gate: held
-- =============================================================================
-- E-386 — DEALER VISIT OUTCOMES AND NEXT VISIT (tracker ID 241-2, agreed 11 Nov, Kartik)
-- =============================================================================
-- WHY.
--   A visit on an existing dealer (My dealers > Log visit) could only pick the
--   lead outcomes ("Price talks moved forward", "Dealer uninterested"). There
--   was no "Order taken", "Payment collected" or "Complaint", no amount the
--   dealer mentioned, and no next visit date, so a promised follow-up was not
--   tracked anywhere.
--
-- WHAT. lead_visits gains three columns, used only on dealer (account) visits:
--   dealer_outcome   order_taken | payment_collected | stock_check |
--                    complaint_service | scheme_explained | dealer_not_present |
--                    other  (vocabulary: src/lib/visits/dealerVisitOutcomes.ts;
--                    free text like visit_outcome, no CHECK, per this table's
--                    convention)
--   reported_amount  the amount the dealer MENTIONED, as reported by the rep.
--                    Never revenue: invoices and payments come only from
--                    Vyapar. No report, target or receivable reads it.
--   no_follow_up     true when the rep ticked "No follow-up needed" instead of
--                    booking a next visit.
--   The next visit itself is an ordinary booked row (visit_status 'scheduled',
--   account_id set, dealer_lead_id NULL) so it shows in My visits as booked.
--
-- NOT mirrored in schema.ts: written and read with raw SQL behind a probe
-- (src/lib/visits/dealerVisitStore.ts hasDealerVisitOutcomes). Before this file
-- is applied the visit form keeps today's outcome list and no next visit.
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

ALTER TABLE lead_visits ADD COLUMN IF NOT EXISTS dealer_outcome varchar(30);
ALTER TABLE lead_visits ADD COLUMN IF NOT EXISTS reported_amount numeric(14, 2);
ALTER TABLE lead_visits ADD COLUMN IF NOT EXISTS no_follow_up boolean;

-- The dealer page timeline and My visits read an account's visits by account.
CREATE INDEX IF NOT EXISTS lead_visits_account_idx
    ON lead_visits (account_id, visit_status)
 WHERE account_id IS NOT NULL;

COMMENT ON COLUMN lead_visits.dealer_outcome IS
    'E-386 (ID 241-2): outcome of a visit on an existing dealer: order_taken, payment_collected, stock_check, complaint_service, scheme_explained, dealer_not_present, other.';
COMMENT ON COLUMN lead_visits.reported_amount IS
    'E-386 (ID 241-2): amount the dealer mentioned, reported by the rep. NEVER revenue; invoices and payments come only from Vyapar.';
COMMENT ON COLUMN lead_visits.no_follow_up IS
    'E-386 (ID 241-2): true when the rep chose No follow-up needed instead of booking a next dealer visit.';
