-- =============================================================================
-- E-385 — AI ANALYST: "EMAIL ME THIS EVERY MORNING" (251 item 23, 16 Nov)
-- =============================================================================
-- WHY.
--   Repeat questions ("visits by each salesperson yesterday") are asked by hand
--   every day. A person can now press the envelope under an answer; the same
--   question is asked afresh each morning and its answer is mailed to them at
--   09:00 IST by the scheduled email reports (digest kind analyst_daily, one
--   mail per person, claimed per person in digest_person_runs, E-353).
--
-- WHAT. analyst_daily_questions — one row per (person, question):
--   user_id        the CRM user who asked for it (users.id); the mail goes to them
--   connection_id  the agent data source the answer came from
--   question       the question as typed (metric rules go in `instructions`)
--   source_run_id  the answer the envelope was pressed on (marks it on screen)
--   active         false once they stop it; stopped_at says when
--
-- A raw-SQL table behind to_regclass (src/lib/analyst/dailyStore.ts), NOT
-- mirrored in schema.ts: without it the envelope is hidden and the mail finds
-- nobody to send to. Strictly additive, idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS analyst_daily_questions (
    id             text         PRIMARY KEY DEFAULT ('adq_' || replace(gen_random_uuid()::text, '-', '')),
    user_id        text         NOT NULL,
    connection_id  varchar(100) NOT NULL,
    question       text         NOT NULL,
    source_run_id  varchar(64),
    active         boolean      NOT NULL DEFAULT true,
    created_at     timestamptz  NOT NULL DEFAULT now(),
    stopped_at     timestamptz
);

-- One live copy of a question per person (asking for it twice is a no-op).
CREATE UNIQUE INDEX IF NOT EXISTS analyst_daily_questions_live_uniq
    ON analyst_daily_questions (user_id, lower(btrim(question)))
 WHERE active;
CREATE INDEX IF NOT EXISTS analyst_daily_questions_user_idx
    ON analyst_daily_questions (user_id, active);

COMMENT ON TABLE analyst_daily_questions IS
    'E-385: AI Analyst questions mailed fresh every morning (251 item 23); src/lib/analyst/dailyStore.ts.';
