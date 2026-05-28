-- E-107 — Step 2.5 mid-flow CEO verification stamping (NBFC Onboarding Plan §10.1 ★)
-- Adds two nullable columns to nbfc capturing when and by whom the CEO
-- verified all compliance documents in Step 2.5. The LSP signer form gate
-- reads docs_verified_at IS NOT NULL to unlock Step 3 for the Admin.
-- Idempotent + additive — safe to re-run.

ALTER TABLE "nbfc"
  ADD COLUMN IF NOT EXISTS "docs_verified_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "docs_verified_by" uuid;

CREATE INDEX IF NOT EXISTS "nbfc_docs_verified_at_idx"
  ON "nbfc" ("docs_verified_at")
  WHERE "docs_verified_at" IS NOT NULL;
