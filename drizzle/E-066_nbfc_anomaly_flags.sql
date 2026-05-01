-- E-066 — Auto Anomaly Flag on NBFC record (BRD §6.3.2)
-- Persistent record of auto-flagged NBFCs with severity and reasons; required
-- so Ops team can track open investigations and the flag survives between
-- metric refreshes. Thresholds (configured for E-066 per user direction):
--   delinquency_pct > 15, recovery_rate_pct < 70, avg_dpd > 30
--   2-of-3 breaches => severity 'red'; 1-of-3 => 'amber'.
CREATE TABLE IF NOT EXISTS "nbfc_anomaly_flags" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "nbfc_id" uuid NOT NULL REFERENCES "nbfc_tenants"("id"),
  "severity" varchar(10) NOT NULL,
  "reasons" jsonb NOT NULL,
  "flagged_at" timestamp with time zone DEFAULT now() NOT NULL,
  "cleared_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "nbfc_anomaly_flags_nbfc_idx"
  ON "nbfc_anomaly_flags" ("nbfc_id");
CREATE INDEX IF NOT EXISTS "nbfc_anomaly_flags_severity_idx"
  ON "nbfc_anomaly_flags" ("severity");
CREATE INDEX IF NOT EXISTS "nbfc_anomaly_flags_flagged_at_idx"
  ON "nbfc_anomaly_flags" ("flagged_at");
CREATE INDEX IF NOT EXISTS "nbfc_anomaly_flags_cleared_at_idx"
  ON "nbfc_anomaly_flags" ("cleared_at");
