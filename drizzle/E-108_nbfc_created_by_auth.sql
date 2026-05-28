-- E-108 — owner-scoped NBFC drafts ("My Submitted Drafts" sidebar entry)
--
-- Legacy `nbfc.created_by` is an INTEGER (back when users.id was numeric),
-- but the live `users.id` is UUID. The integer column is therefore unusable
-- for "who created this draft?" — every real-user insert lands as 0.
--
-- Additive fix: a nullable UUID column populated on insert with the
-- Supabase auth user id. Old rows stay NULL (legacy) and remain visible
-- only in the global directory, not in "My Submitted Drafts".
--
-- Idempotent + additive — safe to re-run.

ALTER TABLE "nbfc"
  ADD COLUMN IF NOT EXISTS "created_by_auth_id" uuid;

CREATE INDEX IF NOT EXISTS "nbfc_created_by_auth_id_idx"
  ON "nbfc" ("created_by_auth_id")
  WHERE "created_by_auth_id" IS NOT NULL;
