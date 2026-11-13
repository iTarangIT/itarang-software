-- =============================================================================
-- E-380 — AI ANALYST: THUMBS UP / DOWN ON AN ANSWER, AND A REVIEW QUEUE
-- =============================================================================
-- WHY.
--   A wrong analyst answer ("Biplabh did 0 visits" when the name matched no one)
--   had nowhere to go. The CEO / Sales Head now rate each answer; a thumbs-down
--   (with an optional note) lands in a review queue at /ceo/analyst/feedback.
--
-- WHAT. analyst_feedback — one row per (run, user):
--   run_id, thread_id  the agent's run and the CRM-owned thread (crm.<user>.<uuid>)
--   user_id            the CRM user who rated (users.id)
--   rating             up | down
--   comment            what was wrong (optional)
--   question, answer   a snapshot: the agent keeps runs, but the reviewer must
--                      see what was asked and said even if the run goes away
--   status             new | reviewed
--   reviewed_by / reviewed_at / review_note
--   created_at / updated_at
--
-- A new raw-SQL table behind to_regclass (src/lib/analyst/feedbackStore.ts),
-- NOT mirrored in schema.ts: without it the thumbs are hidden and the queue
-- says the table is missing. Strictly additive, idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS analyst_feedback (
    id           text         PRIMARY KEY DEFAULT ('afb_' || replace(gen_random_uuid()::text, '-', '')),
    run_id       varchar(64)  NOT NULL,
    thread_id    varchar(100) NOT NULL,
    user_id      text         NOT NULL,
    rating       varchar(4)   NOT NULL CHECK (rating IN ('up', 'down')),
    comment      text,
    question     text,
    answer       text,
    status       varchar(10)  NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed')),
    reviewed_by  text,
    reviewed_at  timestamptz,
    review_note  text,
    created_at   timestamptz  NOT NULL DEFAULT now(),
    updated_at   timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS analyst_feedback_run_user_uniq
    ON analyst_feedback (run_id, user_id);
CREATE INDEX IF NOT EXISTS analyst_feedback_thread_user_idx
    ON analyst_feedback (thread_id, user_id);
CREATE INDEX IF NOT EXISTS analyst_feedback_queue_idx
    ON analyst_feedback (status, rating, created_at DESC);

COMMENT ON TABLE analyst_feedback IS
    'E-380: thumbs up/down on AI Analyst answers + review queue; src/lib/analyst/feedbackStore.ts.';
