-- E-221: CEO approval gate on lead quotations.
--
-- WHY
--   Issuing a quote to a dealer was ungated: any inside_sales_rep / asm / admin
--   could put any number in front of a dealer, while the DEAL that quote turns
--   into needs three levels of approval. This closes that gap — every
--   quote_issue / quote_revision now waits for the CEO before it may be sent.
--
-- WHY COLUMNS AND NOT AN APPROVALS TABLE
--   dealer_lead_commercials is already versioned: version_no per lead, exactly
--   one is_current row, enforced by dealer_lead_commercials_lead_version_uniq.
--   That version IS the unit being approved. Keeping the decision on the same
--   row means the version and its approval state cannot drift apart, rejection
--   is a matter of moving is_current back to the previous version, and a
--   revision after rejection is the existing version_no = max+1 path with no
--   special casing. A separate table would be a second source of truth about a
--   question this one already answers.
--
-- BACKFILL: EXISTING ROWS ARE 'approved'
--   They were issued before any gate existed and many have already been acted
--   on. Defaulting them to 'pending' would retroactively invalidate every quote
--   in the system and fill the CEO's queue with historical rows. The column
--   default is 'approved' for the same reason a legacy row is not suspect —
--   only rows written by the new gated path are set to 'pending' explicitly.
--
-- Free text, no CHECK and no enum, per this table family's convention
-- (cf. E-202_dealer_type, E-218_expense_buckets, E-220). The vocabulary lives
-- in src/lib/leads/quoteApproval.ts and is enforced by zod at the write path.
--
-- Additive and idempotent — safe to re-run.

ALTER TABLE dealer_lead_commercials
  ADD COLUMN IF NOT EXISTS approval_status varchar(16) DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason text;

COMMENT ON COLUMN dealer_lead_commercials.approval_status IS
  'E-221: pending | approved | rejected. Only quote_issue / quote_revision are '
  'gated; other event types are written approved. Pre-E-221 rows are approved.';

-- Only what has never been set — a re-run must not overwrite a real decision.
UPDATE dealer_lead_commercials
   SET approval_status = 'approved'
 WHERE approval_status IS NULL;

-- The CEO queue reads exactly this predicate, and pending is a small slice of
-- the table, so a partial index keeps the panel off a full scan as the
-- commercials history grows.
CREATE INDEX IF NOT EXISTS dealer_lead_commercials_pending_idx
  ON dealer_lead_commercials (created_at)
  WHERE approval_status = 'pending';
