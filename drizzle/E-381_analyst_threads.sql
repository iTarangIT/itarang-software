-- =============================================================================
-- E-381 — AI ANALYST: THE CALLER'S OWN CONVERSATION LIST (rename, pin, archive,
--         delete, search, share)
-- =============================================================================
-- WHY.
--   The conversation column was cut from the agent's tenant-wide top 200 threads
--   (every CRM user shares one agent tenant), so older conversations vanished, and
--   there was nowhere to keep a custom title, a pin, an archive or a share link.
--
-- WHAT. analyst_threads — one row per CRM-owned conversation (crm.<user>.<uuid>):
--   title / title_custom   the first question, or the user's own name for it
--   first_question, questions   every question asked, newline-joined (search)
--   connection_id, run_count, last_asked_at
--   pinned_at              set = pinned to the top
--   archived_at            set = in the Archived list
--   deleted_at             set = deleted by the user; the row (and the agent's
--                          runs) are kept, nothing is ever hard-deleted
--   share_token / shared_at   a read-only link for other analyst users
--
-- A new raw-SQL table behind to_regclass (src/lib/analyst/threadStore.ts), NOT
-- mirrored in schema.ts: without it the list falls back to the agent's list and
-- the rename / pin / archive / delete / share controls are hidden.
-- Strictly additive, idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS analyst_threads (
    thread_id       varchar(100) PRIMARY KEY,
    user_id         text         NOT NULL,
    title           text         NOT NULL,
    title_custom    boolean      NOT NULL DEFAULT false,
    first_question  text,
    questions       text         NOT NULL DEFAULT '',
    connection_id   varchar(100),
    run_count       integer      NOT NULL DEFAULT 0,
    last_asked_at   timestamptz  NOT NULL DEFAULT now(),
    pinned_at       timestamptz,
    archived_at     timestamptz,
    deleted_at      timestamptz,
    share_token     varchar(64),
    shared_at       timestamptz,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analyst_threads_user_list_idx
    ON analyst_threads (user_id, deleted_at, archived_at, pinned_at DESC, last_asked_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS analyst_threads_share_token_uniq
    ON analyst_threads (share_token) WHERE share_token IS NOT NULL;

COMMENT ON TABLE analyst_threads IS
    'E-381: AI Analyst conversation list per CRM user (title, pin, archive, soft delete, share); src/lib/analyst/threadStore.ts.';
