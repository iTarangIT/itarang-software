-- E-285 — Multi-party delete for a customer application.
--
-- Deleting a lead used to be a single dealer-side hard cascade: one click in
-- /dealer-portal/leads wiped the row and ~20 child tables, and with it the
-- admin's and the NBFC's copy of a file they were still working. A dealer
-- tidying their own list should not be able to erase an application out from
-- under a lender.
--
-- Deletion is now per-party. Each party hides the application from its OWN
-- dashboard; the row itself survives until every party that can see it has
-- deleted it, and only then does the hard cascade run.
--
--   dealer  -> leads.deleted_by_dealer_at
--   admin   -> leads.deleted_by_admin_at
--   NBFC    -> nbfc_lead_assignments.deleted_at   (PER TENANT — a lead routed
--              to two lenders is only NBFC-clear once both have deleted it)
--
-- Purely additive. No backfill: every existing row is "not deleted by anyone",
-- which is exactly right.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS deleted_by_dealer_at   timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS deleted_by_dealer_user uuid;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS deleted_by_admin_at    timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS deleted_by_admin_user  uuid;

ALTER TABLE nbfc_lead_assignments ADD COLUMN IF NOT EXISTS deleted_at      timestamptz;
ALTER TABLE nbfc_lead_assignments ADD COLUMN IF NOT EXISTS deleted_by_user uuid;

-- Every dealer/admin list query gains an "IS NULL" predicate. Partial indexes
-- on the DELETED rows are useless here (the common case is NULL); what these
-- give is a cheap way to find what each party has hidden — the "restore"
-- surface, and the purge sweep.
CREATE INDEX IF NOT EXISTS leads_deleted_by_dealer_idx
  ON leads (deleted_by_dealer_at) WHERE deleted_by_dealer_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_deleted_by_admin_idx
  ON leads (deleted_by_admin_at) WHERE deleted_by_admin_at IS NOT NULL;

-- The NBFC-clear check is "does any LIVE assignment remain for this lead", so
-- the index that matters is the one over the not-yet-deleted rows.
CREATE INDEX IF NOT EXISTS nbfc_lead_assignments_live_idx
  ON nbfc_lead_assignments (lead_id) WHERE deleted_at IS NULL;
