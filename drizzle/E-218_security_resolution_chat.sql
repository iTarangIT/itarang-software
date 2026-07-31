-- E-218 — AI resolution chat + auto-apply report for security findings.
--
-- Adds the per-finding remediation conversation (security_finding_messages) and
-- the resolution bookkeeping columns on security_findings. A human chats with
-- an agent that has read the affected source file; when convinced they hit
-- "Resolve", which auto-applies the agreed code fix and records how it was
-- resolved here.
--
--   security_finding_messages   one row per chat turn (mirrors
--                               conversation_messages). The assistant row that
--                               proposes an applyable edit carries proposed_fix
--                               = { file, search, replace, explanation }.
--   security_findings.*         resolution_summary / resolution_report /
--                               resolved_by / resolution_method — filled when a
--                               finding is resolved via the chat.
--
-- Additive + idempotent. Re-running this file is a no-op.

CREATE TABLE IF NOT EXISTS "security_finding_messages" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "finding_id"   uuid NOT NULL REFERENCES "security_findings" ("id") ON DELETE CASCADE,
  -- 'user' | 'assistant' | 'system'
  "role"         text NOT NULL,
  "message"      text NOT NULL,
  -- Present only on an assistant turn that proposes a concrete, applyable edit:
  -- { file, search, replace, explanation }. search is an exact snippet copied
  -- from the real source so the apply step is a deterministic single-occurrence
  -- string replacement.
  "proposed_fix" jsonb,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "security_finding_messages_finding_idx"
  ON "security_finding_messages" ("finding_id", "created_at");

-- Resolution bookkeeping on the finding itself (all additive / nullable).
ALTER TABLE "security_findings"
  ADD COLUMN IF NOT EXISTS "resolution_summary" text;
ALTER TABLE "security_findings"
  ADD COLUMN IF NOT EXISTS "resolution_report" jsonb;
ALTER TABLE "security_findings"
  ADD COLUMN IF NOT EXISTS "resolved_by" uuid;
-- 'auto_apply' (fix written to disk via the chat) | 'manual' (marked resolved).
ALTER TABLE "security_findings"
  ADD COLUMN IF NOT EXISTS "resolution_method" varchar(16);

COMMENT ON TABLE "security_finding_messages" IS
  'E-218 — per-finding AI remediation chat. Assistant rows may carry proposed_fix (an exact search/replace edit) that the Resolve step applies to disk.';
