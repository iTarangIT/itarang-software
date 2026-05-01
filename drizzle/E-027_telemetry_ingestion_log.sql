-- E-027 — Portfolio Data Freshness Badge (BRD §6.1.3)
-- Adds telemetry_ingestion_log so the freshness endpoint can compute the
-- most recent IoT ingestion for a tenant's portfolio.

CREATE TABLE IF NOT EXISTS "telemetry_ingestion_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "battery_serial" varchar(64) NOT NULL,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "telemetry_ingestion_log_tenant_idx"
  ON "telemetry_ingestion_log" ("tenant_id");

CREATE INDEX IF NOT EXISTS "telemetry_ingestion_log_tenant_ingested_idx"
  ON "telemetry_ingestion_log" ("tenant_id", "ingested_at");
