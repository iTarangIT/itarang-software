-- E-119 — nbfc_battery_evaluations (BRD §6.1.7 Recovery & Auction)
-- The 3-step battery evaluation (Technical → Refurbishment → Pricing) recorded
-- by the recovery operator before a battery is auctioned or scrapped. The
-- table is defined in src/lib/db/schema.ts (nbfcBatteryEvaluations) but had no
-- migration file — this back-fills it.
--
-- Strictly additive. Idempotent. Re-running this file is a no-op.

CREATE TABLE IF NOT EXISTS "nbfc_battery_evaluations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "recovery_pipeline_id" uuid NOT NULL,
  "step1" jsonb NOT NULL,
  "step2" jsonb NOT NULL,
  "step3" jsonb NOT NULL,
  "base_auction_price" numeric(12, 2),
  "rejected" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "nbfc_battery_evaluations_tenant_idx"
  ON "nbfc_battery_evaluations" ("tenant_id");

CREATE INDEX IF NOT EXISTS "nbfc_battery_evaluations_pipeline_idx"
  ON "nbfc_battery_evaluations" ("recovery_pipeline_id");
