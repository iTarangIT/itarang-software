-- E-049 — Telemetry alert rules ledger (BRD §6.2.6)
--
-- Persistent store for the eight rule-based alerts triggered by the
-- per-packet evaluator and the offline-scan cron. Dedup contract: one open
-- alert per (serial_number, rule) — enforced via a partial unique index
-- WHERE resolved_at IS NULL so that closed alerts can be re-opened.
--
-- Reuse-vs-new disposition (auto-approved, _audit_E-049.json): kept as a
-- separate table from the existing battery_alerts (varchar(255) PK +
-- alert_type/message shape) because the BRD model is rule-based with a JSON
-- payload, JSON notified_to fan-out audit, open/resolved lifecycle and a
-- cds_flagged escalation flag.

CREATE TABLE IF NOT EXISTS "telemetry_alerts" (
  "id"             serial PRIMARY KEY,
  "serial_number" varchar(50) NOT NULL,
  "rule"           varchar(50) NOT NULL,
  "severity"       varchar(20) NOT NULL,
  "triggered_at"   timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at"    timestamp with time zone,
  "payload"        jsonb,
  "notified_to"    jsonb,
  "cds_flagged"    boolean DEFAULT false NOT NULL
);

-- Dedup: one open alert per (serial_number, rule). Closed alerts (resolved_at
-- non-null) are excluded so the same rule can fire again after resolution.
CREATE UNIQUE INDEX IF NOT EXISTS "telemetry_alerts_serial_rule_open_uniq"
  ON "telemetry_alerts" ("serial_number", "rule")
  WHERE "resolved_at" IS NULL;

CREATE INDEX IF NOT EXISTS "telemetry_alerts_serial_triggered_idx"
  ON "telemetry_alerts" ("serial_number", "triggered_at");

CREATE INDEX IF NOT EXISTS "telemetry_alerts_severity_idx"
  ON "telemetry_alerts" ("severity");
