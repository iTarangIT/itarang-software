-- E-216 — Live-attack event log (runtime intrusion detection).
--
-- The E-215 scanner finds vulnerabilities proactively. This table is the OTHER
-- half: a record of suspicious/malicious requests caught in real time by the
-- detection layer in src/middleware.ts (SQLi/XSS/path-traversal payloads,
-- scanner user-agents, unauthenticated hits on sensitive endpoints, request
-- bursts). One row per detected event.
--
-- The middleware (Edge runtime) cannot write to Postgres directly, so it fires
-- the event to POST /api/internal/security-events (Node runtime), which writes
-- here, escalates on bursts, and sends a rate-limited alert.
--
-- Additive + idempotent. Re-running this file is a no-op.

CREATE TABLE IF NOT EXISTS "security_events" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "occurred_at"    timestamptz NOT NULL DEFAULT now(),
  -- 'sql_injection' | 'xss' | 'path_traversal' | 'null_byte' | 'scanner_ua'
  -- | 'sensitive_unauth' | 'burst'
  "event_type"     varchar(32) NOT NULL,
  -- critical | high | medium | low | info (same ladder as security_findings).
  "severity"       varchar(12) NOT NULL,
  -- 'blocked' (request was 403'd) | 'logged' (allowed through, recorded).
  "action"         varchar(12) NOT NULL DEFAULT 'logged',
  "ip"             varchar(64),
  "actor_user_id"  uuid,
  "actor_role"     varchar(32),
  "method"         varchar(8),
  "path"           text NOT NULL,
  "query"          text,
  "user_agent"     text,
  "matched_rule"   varchar(64),
  "evidence"       jsonb,
  -- Triage lifecycle: 'new' | 'reviewed' | 'ignored'.
  "status"         varchar(16) NOT NULL DEFAULT 'new',
  -- Set when an alert was sent for this event (used for per-IP alert throttling).
  "alerted_at"     timestamptz,
  "created_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "security_events_occurred_idx"
  ON "security_events" ("occurred_at" DESC);

CREATE INDEX IF NOT EXISTS "security_events_severity_idx"
  ON "security_events" ("severity");

-- Burst detection + per-IP alert throttle both scan recent rows for one IP.
CREATE INDEX IF NOT EXISTS "security_events_ip_occurred_idx"
  ON "security_events" ("ip", "occurred_at" DESC);

CREATE INDEX IF NOT EXISTS "security_events_status_idx"
  ON "security_events" ("status");

COMMENT ON TABLE "security_events" IS
  'E-216 — runtime intrusion-detection log. One row per suspicious request caught by the middleware detection layer; written via /api/internal/security-events.';
