-- Index dealer_onboarding_documents.application_id so the admin verifications
-- list endpoint (src/app/api/admin/dealer-verifications/route.ts) can look up
-- per-application document counts without a sequential scan.

CREATE INDEX IF NOT EXISTS "dealer_onboarding_documents_application_id_idx"
  ON "dealer_onboarding_documents" ("application_id");
