-- E-144 — drop the nbfc_loans → loan_applications foreign key
--
-- nbfc_loans is the NBFC servicing ledger. Its PK `loan_application_id` is keyed
-- to DIFFERENT sources depending on how the row was created:
--   • legacy seed / CSV import → the NBFC's own loan id
--   • origination bridge       → loan_sanctions.id (projectDisbursedLoan, §6.1.3)
--
-- A leftover FK `nbfc_loans_loan_application_id_fkey → loan_applications(id)`
-- (from when nbfc_loans only ever bridged loan_applications) is incompatible
-- with both newer sources: the disbursement bridge inserts a loan_sanctions id
-- (LS-…) that has no loan_applications row, so the projection fails with a FK
-- violation and breaks the dealer's Step-5 dispatch. The Drizzle schema does
-- NOT declare this FK (loan_application_id is a plain primary key) — it survives
-- only in the DB from an earlier migration / db:push.
--
-- Idempotent and non-destructive: removes only the constraint. The primary key
-- on loan_application_id (uniqueness / idempotency) and all data are untouched.

ALTER TABLE nbfc_loans DROP CONSTRAINT IF EXISTS nbfc_loans_loan_application_id_fkey;
