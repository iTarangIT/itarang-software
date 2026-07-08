-- E-183 — Standalone EMI Tracker rows (bulk-upload rows with no matching loan).
--
-- The EMI Tracker's bulk upload matches each sheet row to a loan already on the
-- tracker by battery serial. A row with NO matching loan used to be a hard
-- error. This migration lets an operator FORCE-IMPORT such a row as a
-- STANDALONE, display-only tracker entry:
--   * loan_application_id = NULL  (there is no loan to key off / fall back to)
--   * is_standalone       = true
--   * every display column (borrower/serial/emi/next_due/last_paid/progress/
--     status/dpd/mandate/next_auto_debit/financier) is carried BY THE ROW ITSELF
--     — the EMI Tracker page UNIONs these rows in and reads them verbatim.
--
-- Because there is no underlying loan, a standalone row has no EMI schedule, no
-- E-NACH mandate and no drawer — it is purely a display record and never feeds
-- CDS/PCI/DPD. It is edited/deleted by its own id via
-- /api/nbfc/emi-tracker/standalone/[id].
--
-- Strictly additive. Idempotent.

-- 1. Allow a standalone override row to carry no loan (widening — NULLs allowed).
--    Idempotent: DROP NOT NULL on an already-nullable column is a no-op.
ALTER TABLE nbfc_emi_tracker_overrides
  ALTER COLUMN loan_application_id DROP NOT NULL;

-- 2. Flag standalone rows.
ALTER TABLE nbfc_emi_tracker_overrides
  ADD COLUMN IF NOT EXISTS is_standalone boolean NOT NULL DEFAULT false;

-- 3. Dedupe standalone rows by battery serial (one per tenant+serial). The
--    existing (tenant_id, loan_application_id) unique index does not constrain
--    standalone rows because loan_application_id is NULL there and NULLs are
--    distinct in a unique index — so add a partial unique index on the
--    normalised serial for standalone rows only.
CREATE UNIQUE INDEX IF NOT EXISTS nbfc_emi_tracker_overrides_standalone_serial_uidx
  ON nbfc_emi_tracker_overrides (tenant_id, lower(vehicleno))
  WHERE is_standalone;
