-- E-141 — Addendum V0.2 §12.1 (Financing Dead-End). Two additive columns on
-- leads to record the admin-confirmed terminal "Financing Unavailable" state
-- and the category-level decline reason. The reason is retained even after the
-- §12.3 finance-data purge runs (the purge nulls sensitive data, not these).
--
-- Strictly additive + idempotent — re-running is a no-op.

ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "financing_decline_category" varchar(40);

ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "financing_unavailable_at" timestamptz;

COMMENT ON COLUMN "leads"."financing_decline_category" IS
  'Addendum V0.2 §12.1 — category-level decline reason: all_declined | no_match | handoff_unanswered. Retained post-purge (§12.3).';
