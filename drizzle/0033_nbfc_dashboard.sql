-- NBFC Risk Dashboard — Phase A schema migration
-- See docs/NBFC_DASHBOARD_PLAN.md for the full design.
--
-- Adds 5 tables:
--   nbfc_tenants, nbfc_users, nbfc_loans, risk_hypotheses, risk_card_runs
--
-- users.role gains a new value 'nbfc_partner' (no enum to alter — role is varchar(50)).

CREATE TABLE IF NOT EXISTS "nbfc_tenants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "display_name" text NOT NULL,
  "contact_email" text,
  "aum_inr" numeric(16, 2),
  "active_loans" integer DEFAULT 0 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "nbfc_users" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "tenant_id" uuid NOT NULL REFERENCES "nbfc_tenants"("id") ON DELETE CASCADE,
  "role" varchar(32) DEFAULT 'viewer' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "tenant_id")
);
CREATE INDEX IF NOT EXISTS "nbfc_users_user_tenant_idx" ON "nbfc_users" ("user_id", "tenant_id");
CREATE INDEX IF NOT EXISTS "nbfc_users_tenant_idx" ON "nbfc_users" ("tenant_id");

CREATE TABLE IF NOT EXISTS "nbfc_loans" (
  "loan_application_id" varchar(255) PRIMARY KEY REFERENCES "loan_applications"("id") ON DELETE CASCADE,
  "tenant_id" uuid NOT NULL REFERENCES "nbfc_tenants"("id") ON DELETE RESTRICT,
  "vehicleno" varchar(64),
  "emi_amount" numeric(12, 2),
  "emi_due_date_dom" integer,
  "current_dpd" integer DEFAULT 0 NOT NULL,
  "outstanding_amount" numeric(14, 2),
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "nbfc_loans_tenant_idx" ON "nbfc_loans" ("tenant_id");
CREATE INDEX IF NOT EXISTS "nbfc_loans_vno_idx" ON "nbfc_loans" ("vehicleno");
CREATE INDEX IF NOT EXISTS "nbfc_loans_dpd_idx" ON "nbfc_loans" ("current_dpd");

CREATE TABLE IF NOT EXISTS "risk_hypotheses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "title" text NOT NULL,
  "description" text NOT NULL,
  "test_method" varchar(16) NOT NULL,
  "test_definition" jsonb NOT NULL,
  "source" varchar(16) DEFAULT 'human' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "retired_at" timestamptz
);

CREATE TABLE IF NOT EXISTS "risk_card_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "nbfc_tenants"("id") ON DELETE CASCADE,
  "hypothesis_id" uuid NOT NULL REFERENCES "risk_hypotheses"("id") ON DELETE CASCADE,
  "run_at" timestamptz DEFAULT now() NOT NULL,
  "severity" varchar(16) NOT NULL,
  "finding_summary" text NOT NULL,
  "affected_count" integer DEFAULT 0 NOT NULL,
  "total_count" integer DEFAULT 0 NOT NULL,
  "evidence_json" jsonb,
  "llm_critique" text,
  "llm_model" varchar(64),
  "llm_prompt_tokens" integer,
  "llm_completion_tokens" integer
);
CREATE INDEX IF NOT EXISTS "risk_card_runs_tenant_run_idx" ON "risk_card_runs" ("tenant_id", "run_at");
CREATE INDEX IF NOT EXISTS "risk_card_runs_tenant_hyp_idx" ON "risk_card_runs" ("tenant_id", "hypothesis_id");
CREATE INDEX IF NOT EXISTS "risk_card_runs_severity_idx" ON "risk_card_runs" ("severity");

-- Seed the 5 hand-coded hypotheses (slugs match src/lib/risk/hand-coded-cards.ts).
INSERT INTO "risk_hypotheses" ("slug", "title", "description", "test_method", "test_definition", "source")
VALUES
  ('usage-drop-7d', '7-day usage cliff',
   'Borrowers whose 7-day km is at least 40% below their prior 7-day baseline. Sharp utilization drops historically precede payment delinquency by 2-3 weeks.',
   'js', '{"kind":"hand_coded","fn":"usageDrop7d"}', 'human'),
  ('dpd-7-no-telemetry', 'Past-due + telemetry silent',
   'Loans 7+ days past due whose vehicles have not reported GPS in over 6 hours. Combination signals concealment risk.',
   'js', '{"kind":"hand_coded","fn":"dpd7NoTelemetry"}', 'human'),
  ('geo-shift', 'Vehicle outside operating radius',
   'Vehicles whose current location is more than 100 km from their onboarding region centroid. Possible asset diversion.',
   'js', '{"kind":"hand_coded","fn":"geoShift"}', 'human'),
  ('battery-soh-decay', 'Accelerated battery degradation',
   'Vehicles whose State-of-Health (SOH) has dropped more than 5 percentage points in the last 30 days. Affects both asset value and operator income.',
   'js', '{"kind":"hand_coded","fn":"batterySohDecay"}', 'human'),
  ('low-utilization-active-loan', 'Active loan, low utilization',
   'Loans with current EMI obligation whose vehicles averaged under 20 km/day in the last 14 days. Operator may be churning or sub-letting.',
   'js', '{"kind":"hand_coded","fn":"lowUtilizationActiveLoan"}', 'human')
ON CONFLICT ("slug") DO NOTHING;
