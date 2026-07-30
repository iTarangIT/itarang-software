-- E-219 — resolution audit trail for security findings (the History tab).
--
-- E-218 recorded only the FINAL resolution state on security_findings
-- (resolution_summary / resolution_report / resolved_by / resolution_method).
-- That answers "was it resolved" but not "who did what, when, and from where" —
-- and the manual triage buttons (Mark Resolved / False Positive / Reopen) wrote
-- nothing at all beyond the status.
--
-- This migration adds:
--   security_finding_actions      one row per triage/resolution action on a
--                                 finding (acknowledged | resolved |
--                                 false_positive | reopened | auto_apply), with
--                                 the actor (user id / email / role) and the
--                                 REQUEST ORIGIN (ip, user_agent) it came from.
--                                 Append-only; a reopen does not erase history.
--   security_findings.resolved_ip / resolved_user_agent / resolved_by_email
--                                 denormalised "who + from where" for the
--                                 latest resolution, so the History cards render
--                                 without a join.
--
-- Read by /it/security/history (History tab) and the resolution drawer.
--
-- Additive + idempotent. Re-running this file is a no-op. Wrapped in a DO block
-- so it is a harmless notice where E-215 hasn't been applied yet.

DO $do$
BEGIN
  CREATE TABLE IF NOT EXISTS "security_finding_actions" (
    "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "finding_id"    uuid NOT NULL REFERENCES "security_findings" ("id") ON DELETE CASCADE,
    -- 'acknowledged' | 'resolved' | 'false_positive' | 'reopened' | 'auto_apply'
    "action"        varchar(24) NOT NULL,
    -- How the action was carried out: 'auto_apply' (agent wrote the code fix to
    -- disk) | 'manual' (a human clicked a triage button). NULL for actions where
    -- the distinction is meaningless (e.g. 'acknowledged').
    "method"        varchar(16),
    "actor_user_id" uuid,
    "actor_email"   text,
    "actor_role"    varchar(32),
    -- Request origin the action was performed from. Same extraction as
    -- security_events.ip (x-forwarded-for first hop → x-real-ip).
    "ip"            varchar(64),
    "user_agent"    text,
    -- Human-readable one-liner for the timeline row.
    "summary"       text,
    -- Machine detail: for 'auto_apply' the { file, diff, backup_path, verified,
    -- explanation } report; for manual actions the previous status.
    "detail"        jsonb,
    "created_at"    timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS "security_finding_actions_finding_idx"
    ON "security_finding_actions" ("finding_id", "created_at");
  CREATE INDEX IF NOT EXISTS "security_finding_actions_action_idx"
    ON "security_finding_actions" ("action", "created_at" DESC);
  CREATE INDEX IF NOT EXISTS "security_finding_actions_ip_idx"
    ON "security_finding_actions" ("ip");

  -- Denormalised origin of the latest resolution, for the History cards.
  ALTER TABLE "security_findings"
    ADD COLUMN IF NOT EXISTS "resolved_ip" varchar(64);
  ALTER TABLE "security_findings"
    ADD COLUMN IF NOT EXISTS "resolved_user_agent" text;
  ALTER TABLE "security_findings"
    ADD COLUMN IF NOT EXISTS "resolved_by_email" text;

EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'skip E-219: security_findings does not exist (apply E-215 first)';
END;
$do$;

COMMENT ON TABLE "security_finding_actions" IS
  'E-219 — append-only resolution/triage audit trail per security finding: action, actor (id/email/role), origin (ip/user_agent) and detail. Feeds the History tab at /it/security/history.';
