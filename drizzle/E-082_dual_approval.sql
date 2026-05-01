-- E-082 — Dual approval gate primitive
-- Two new tables: dual_approval_requests + dual_approval_action_config

CREATE TABLE IF NOT EXISTS "dual_approval_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "action_type" varchar(64) NOT NULL,
  "entity_id" varchar(255) NOT NULL,
  "initiator_user_id" uuid NOT NULL,
  "approver_user_id" uuid,
  "required_approver_role" varchar(64) NOT NULL,
  "status" varchar(24) DEFAULT 'pending_approval' NOT NULL,
  "reason_code" varchar(64) NOT NULL,
  "evidence_snapshot" jsonb NOT NULL,
  "borrower_notice_id" varchar(255),
  "rejection_reason" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "approved_at" timestamptz,
  "rejected_at" timestamptz,
  "expired_at" timestamptz,
  CONSTRAINT "dual_approval_requests_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "nbfc_tenants"("id")
);

CREATE INDEX IF NOT EXISTS "dual_approval_requests_tenant_status_idx"
  ON "dual_approval_requests" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "dual_approval_requests_initiator_idx"
  ON "dual_approval_requests" ("initiator_user_id");
CREATE INDEX IF NOT EXISTS "dual_approval_requests_expires_idx"
  ON "dual_approval_requests" ("expires_at");

CREATE TABLE IF NOT EXISTS "dual_approval_action_config" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "action_type" varchar(64) NOT NULL,
  "initiator_role" varchar(64) NOT NULL,
  "approver_role" varchar(64) NOT NULL
);

CREATE INDEX IF NOT EXISTS "dual_approval_action_config_action_type_idx"
  ON "dual_approval_action_config" ("action_type");
