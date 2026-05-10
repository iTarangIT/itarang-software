-- E-085 — Risk rule threshold change (gated by dual approval)
-- Append-only history of risk-rule threshold mutations.

CREATE TABLE IF NOT EXISTS "nbfc_risk_rule_thresholds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "rule_key" varchar(128) NOT NULL,
  "prior_threshold_json" jsonb,
  "new_threshold_json" jsonb NOT NULL,
  "approval_request_id" uuid NOT NULL,
  "applied_at" timestamptz,
  "applied_by" uuid,
  "is_active" boolean DEFAULT true NOT NULL
);

CREATE INDEX IF NOT EXISTS "nbfc_risk_rule_thresholds_rule_key_active_idx"
  ON "nbfc_risk_rule_thresholds" ("rule_key", "is_active");
CREATE INDEX IF NOT EXISTS "nbfc_risk_rule_thresholds_approval_request_idx"
  ON "nbfc_risk_rule_thresholds" ("approval_request_id");
