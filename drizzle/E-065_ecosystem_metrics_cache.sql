-- E-065 — NBFC Ecosystem Overview metrics cache (BRD §6.3.2)
-- Stores 15-minute IoT connectivity rollup and nightly Avg CDS network value.
CREATE TABLE IF NOT EXISTS "nbfc_ecosystem_metrics_cache" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "metric_key" varchar(64) NOT NULL UNIQUE,
  "metric_value" numeric(18, 4),
  "refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
