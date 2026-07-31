-- E-215 — CRM Security Scanner (standalone agent).
--
-- Backs a NEW, self-contained security-testing agent that drives a real browser
-- (Playwright) through the CRM starting at dealer onboarding, actively probes
-- for vulnerabilities (broken authZ / IDOR / auth-bypass, sensitive-data
-- exposure, injection / XSS, unsafe file upload + missing security headers) and
-- records what it finds.
--
-- This feature is INDEPENDENT of the NBFC risk engine (risk_hypotheses /
-- risk_card_runs / the Python sandbox). It shares no tables and no code with it
-- — the only thing borrowed is house style. Do not join these tables to the
-- risk_* family.
--
-- Three tables:
--   security_scan_runs  — one row per scan; also the concurrency lock.
--   security_checks     — the catalogue of checks the agent knows how to run.
--   security_findings   — one row per confirmed/suspected vulnerability.
--
-- Severity is deterministic (decided by probe rules, never by the LLM) and uses
-- the pentest-standard ladder: critical | high | medium | low | info.
--
-- Additive + idempotent. Re-running this file is a no-op.

-- ---------------------------------------------------------------------------
-- security_scan_runs — scan header + single-flight lock per target environment.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "security_scan_runs" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Where the scan pointed. env is derived from the URL host.
  "target_base_url"    text NOT NULL,
  "target_env"         varchar(16) NOT NULL,        -- 'local' | 'sandbox' | 'prod'
  "mode"               varchar(12) NOT NULL DEFAULT 'safe',   -- 'safe' | 'aggressive'
  "triggered_by"       varchar(12) NOT NULL,        -- 'manual' | 'cron' | 'cli'
  "actor_user_id"      uuid,
  "status"             varchar(16) NOT NULL DEFAULT 'running', -- 'running' | 'completed' | 'failed'
  "started_at"         timestamptz NOT NULL DEFAULT now(),
  "finished_at"        timestamptz,
  "surfaces_walked"    integer NOT NULL DEFAULT 0,
  "findings_total"     integer NOT NULL DEFAULT 0,
  "findings_critical"  integer NOT NULL DEFAULT 0,
  "findings_high"      integer NOT NULL DEFAULT 0,
  "findings_medium"    integer NOT NULL DEFAULT 0,
  "findings_low"       integer NOT NULL DEFAULT 0,
  "findings_info"      integer NOT NULL DEFAULT 0,
  "prompt_tokens"      integer NOT NULL DEFAULT 0,
  "completion_tokens"  integer NOT NULL DEFAULT 0,
  "error"              text
);

-- Newest-first listing for the dashboard freshness read.
CREATE INDEX IF NOT EXISTS "security_scan_runs_started_idx"
  ON "security_scan_runs" ("started_at" DESC);

-- THE LOCK. One live scan per target environment: a second caller inserting a
-- 'running' row for the same env gets a unique_violation (23505) which the app
-- maps to a 409 "already running". Partial → migration-only (drizzle's builder
-- cannot express the WHERE).
CREATE UNIQUE INDEX IF NOT EXISTS "security_scan_runs_env_running_uidx"
  ON "security_scan_runs" ("target_env")
  WHERE "status" = 'running';

COMMENT ON TABLE "security_scan_runs" IS
  'E-215 — one row per CRM security scan; the partial unique on (target_env) WHERE status=running is the single-flight lock. Standalone from the NBFC risk engine.';

-- ---------------------------------------------------------------------------
-- security_checks — catalogue of known checks (seeded by the app, not here).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "security_checks" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug"              varchar(64) NOT NULL,
  -- 'authz' | 'exposure' | 'injection' | 'upload_headers'
  "category"          varchar(24) NOT NULL,
  "title"             text NOT NULL,
  "description"       text NOT NULL,
  -- Fallback severity if a probe does not pin one. critical|high|medium|low|info
  "default_severity"  varchar(12) NOT NULL DEFAULT 'medium',
  "owasp_ref"         varchar(32),                  -- e.g. 'A01:2021'
  "cwe_ref"           varchar(16),                  -- e.g. 'CWE-639'
  -- Whether running this check mutates server state (skipped in safe mode).
  "mutating"          boolean NOT NULL DEFAULT false,
  -- Soft-retire: keep history, stop running/rendering it.
  "retired_at"        timestamptz,
  "created_at"        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "security_checks_slug_uidx"
  ON "security_checks" ("slug");

COMMENT ON TABLE "security_checks" IS
  'E-215 — catalogue of security checks the scanner agent can run, keyed by slug. Seeded by the app on first run.';

-- ---------------------------------------------------------------------------
-- security_findings — one row per vulnerability the scan surfaced.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "security_findings" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id"            uuid NOT NULL REFERENCES "security_scan_runs"("id") ON DELETE CASCADE,
  "check_slug"        varchar(64) NOT NULL,
  "category"          varchar(24) NOT NULL,
  -- critical | high | medium | low | info — set by the probe rule, not the LLM.
  "severity"          varchar(12) NOT NULL,
  "title"             text NOT NULL,
  "summary"           text NOT NULL,
  "target_url"        text NOT NULL,
  "http_method"       varchar(8),
  -- Request/response snippet, payload used, role/session, screenshot path, etc.
  "evidence_json"     jsonb,
  "reproduction"      text,
  "remediation"       text,
  "owasp_ref"         varchar(32),
  "cwe_ref"           varchar(16),
  -- 'confirmed' | 'likely' | 'possible'
  "confidence"        varchar(10) NOT NULL DEFAULT 'possible',
  -- Triage lifecycle. 'open' | 'acknowledged' | 'resolved' | 'false_positive'
  "status"            varchar(16) NOT NULL DEFAULT 'open',
  -- sha256(check_slug + method + normalised url + key evidence). Dedups repeat
  -- findings of the same issue across re-scans while it is still open.
  "fingerprint"       varchar(64) NOT NULL,
  "acknowledged_at"   timestamptz,
  "resolved_at"       timestamptz,
  "llm_model"         varchar(64),
  "prompt_tokens"     integer,
  "completion_tokens" integer,
  "created_at"        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "security_findings_run_idx"
  ON "security_findings" ("run_id");

CREATE INDEX IF NOT EXISTS "security_findings_severity_idx"
  ON "security_findings" ("severity");

CREATE INDEX IF NOT EXISTS "security_findings_status_idx"
  ON "security_findings" ("status");

-- Open-finding dedup: at most one non-resolved row per fingerprint, so a
-- re-scan updates rather than piles duplicates. Partial → migration-only.
CREATE UNIQUE INDEX IF NOT EXISTS "security_findings_open_fingerprint_uidx"
  ON "security_findings" ("fingerprint")
  WHERE "status" <> 'resolved';

COMMENT ON TABLE "security_findings" IS
  'E-215 — one row per vulnerability found by a CRM security scan. severity/confidence are set by deterministic probe rules; the LLM only narrates. Open findings are deduped by fingerprint.';
