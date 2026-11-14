-- =============================================================================
-- E-382 — AI ANALYST: VERIFIED QUERIES
-- =============================================================================
-- WHY.
--   A checked, known-good SQL query for a question was thrown away after the
--   answer. The CEO / Sales Head can now mark a run's query as verified. A new
--   question that is close to a verified one is sent to the agent with that SQL
--   (in its `instructions`), and an answer whose query is a verified one shows a
--   "Verified" badge.
--
-- WHAT. analyst_verified_queries:
--   connection_id          the data source the query runs on
--   question, question_norm   the question it answers (normalised for matching)
--   sql, sql_norm          the query (normalised: case, spacing, comments, ;)
--   source_run_id          the run it was taken from
--   verified_by / verified_at / note
--   active                 false = verification taken back (kept for history)
--
-- A new raw-SQL table behind to_regclass (src/lib/analyst/verifiedStore.ts), NOT
-- mirrored in schema.ts: without it nothing is matched and no badge shows.
-- Strictly additive, idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS analyst_verified_queries (
    id             text         PRIMARY KEY DEFAULT ('avq_' || replace(gen_random_uuid()::text, '-', '')),
    connection_id  varchar(100) NOT NULL,
    question       text         NOT NULL,
    question_norm  text         NOT NULL,
    sql            text         NOT NULL,
    sql_norm       text         NOT NULL,
    source_run_id  varchar(64),
    verified_by    text         NOT NULL,
    verified_at    timestamptz  NOT NULL DEFAULT now(),
    note           text,
    active         boolean      NOT NULL DEFAULT true,
    created_at     timestamptz  NOT NULL DEFAULT now(),
    updated_at     timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS analyst_verified_queries_active_sql_uniq
    ON analyst_verified_queries (connection_id, sql_norm) WHERE active;
CREATE INDEX IF NOT EXISTS analyst_verified_queries_conn_idx
    ON analyst_verified_queries (connection_id, active, verified_at DESC);

COMMENT ON TABLE analyst_verified_queries IS
    'E-382: AI Analyst verified SQL queries, reused for similar questions; src/lib/analyst/verifiedStore.ts.';
