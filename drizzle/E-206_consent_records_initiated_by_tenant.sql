------------------------------------------------------------------------------
-- E-206: tag consent records with the NBFC tenant that captured them.
--
-- Change (NBFC-owned consent): when the NBFC runs consent itself from the Acquire
-- workspace (e-sign / OTP / manual), the resulting consent_records row is stamped
-- with the acting NBFC tenant. The NBFC's DPDP card filters to its own tenant so
-- it never sees iTarang's / the dealer's customer & co-borrower consent. NULL ⇒
-- iTarang/dealer-captured (unchanged); the admin view is NOT filtered.
--
-- Additive + idempotent. Plain uuid column (no FK) to avoid coupling; the values
-- are nbfc_tenants.id.
------------------------------------------------------------------------------

ALTER TABLE consent_records
  ADD COLUMN IF NOT EXISTS initiated_by_tenant_id uuid;
