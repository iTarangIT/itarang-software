-- E-089 — PII Access Gated (BRD §6.4.3 PII Data Access row)
-- One new table that materialises a time-boxed unmask grant after a
-- dual_approval_requests row of action_type='pii_data_access' is approved
-- by the iTarang Compliance Officer. Used by GET /api/nbfc/pii/unmask.

CREATE TABLE IF NOT EXISTS "nbfc_pii_access_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "lead_id" varchar(255) NOT NULL,
  "requested_by" uuid NOT NULL,
  "approval_request_id" uuid NOT NULL,
  "access_token" varchar(128) NOT NULL,
  "fields" jsonb NOT NULL,
  "granted_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  "used_count" integer DEFAULT 0 NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "nbfc_pii_access_grants_access_token_idx"
  ON "nbfc_pii_access_grants" ("access_token");
CREATE INDEX IF NOT EXISTS "nbfc_pii_access_grants_approval_idx"
  ON "nbfc_pii_access_grants" ("approval_request_id");
CREATE INDEX IF NOT EXISTS "nbfc_pii_access_grants_lead_idx"
  ON "nbfc_pii_access_grants" ("lead_id");
