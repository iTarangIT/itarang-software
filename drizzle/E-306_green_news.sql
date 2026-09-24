-- =============================================================================
-- E-306 — GREEN ENERGY NEWS FEED for the CEO dashboard (2026-09-24)
-- =============================================================================
-- WHY. The CEO wants a daily-updated view of what is happening in green energy
-- (world + India): policy & subsidies, who is earning money and how, where the
-- money comes from (funding / investment / grants), and energy distribution,
-- storage and grid. Nothing news-like existed. A background job pulls RSS
-- feeds + Google News RSS queries, dedupes, tags and summarises them with
-- Gemini, and writes a 5-bullet morning brief. Code: src/lib/news/*.
--
-- WHAT CHANGED (additive; three new tables, nothing else touched):
--
--   green_news_items — one row per distinct article
--     url_hash        sha256 of the canonical URL (utm_* stripped) — UNIQUE, the
--                     insert-time dedupe key (ON CONFLICT DO NOTHING)
--     title_hash      normalised-title key, catches the same story from two
--                     feeds (Google News + the publisher's own RSS)
--     region          'india' | 'world'         (NULL until Gemini classifies)
--     category        vocabulary in src/lib/news/categories.ts (code, not a
--                     CHECK, so the list can grow without DDL)
--     relevance       0-100 from Gemini; below the threshold → hidden = true so
--                     it never shows but is never re-fetched either
--     summary         Gemini one-liner; snippet is the raw feed description
--     classified_at   NULL = still to be classified (retried next run)
--
--   green_news_briefs — one row per IST calendar day, the 5-bullet brief
--     bullets         jsonb [{ text, item_ids: uuid[] }]
--
--   green_news_runs — one row per refresh (ticker / cron / manual), with
--     counts, for the "Updated x min ago" label and the 2 h spacing guard.
--
-- No backfill. Required before the news code deploys (the routes, the card and
-- the ticker read these tables); nothing else depends on them, so old code on
-- a new DB is unaffected.
--
-- Idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS green_news_items (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    url_hash       varchar(64)  NOT NULL,
    url            text         NOT NULL,
    source_key     varchar(40)  NOT NULL,
    source_name    text,
    title          text         NOT NULL,
    title_hash     varchar(64)  NOT NULL,
    snippet        text,
    summary        text,
    image_url      text,
    published_at   timestamptz  NOT NULL,
    fetched_at     timestamptz  NOT NULL DEFAULT now(),
    region         varchar(10),
    category       varchar(30),
    relevance      smallint,
    hidden         boolean      NOT NULL DEFAULT false,
    classified_at  timestamptz,
    created_at     timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS green_news_items_url_hash_uniq
    ON green_news_items (url_hash);
CREATE INDEX IF NOT EXISTS green_news_items_published_idx
    ON green_news_items (published_at DESC);
CREATE INDEX IF NOT EXISTS green_news_items_region_category_idx
    ON green_news_items (region, category, published_at DESC);
CREATE INDEX IF NOT EXISTS green_news_items_title_hash_idx
    ON green_news_items (title_hash);
CREATE INDEX IF NOT EXISTS green_news_items_unclassified_idx
    ON green_news_items (fetched_at) WHERE classified_at IS NULL;

CREATE TABLE IF NOT EXISTS green_news_briefs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    brief_date    date         NOT NULL,
    bullets       jsonb        NOT NULL DEFAULT '[]'::jsonb,
    model         text,
    item_count    integer      NOT NULL DEFAULT 0,
    generated_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS green_news_briefs_date_uniq
    ON green_news_briefs (brief_date);

CREATE TABLE IF NOT EXISTS green_news_runs (
    id             bigserial PRIMARY KEY,
    started_at     timestamptz  NOT NULL DEFAULT now(),
    finished_at    timestamptz,
    status         varchar(16)  NOT NULL DEFAULT 'running',
    triggered_by   varchar(16)  NOT NULL,
    fetched        integer      NOT NULL DEFAULT 0,
    inserted       integer      NOT NULL DEFAULT 0,
    classified     integer      NOT NULL DEFAULT 0,
    brief_written  boolean      NOT NULL DEFAULT false,
    error          text
);

CREATE INDEX IF NOT EXISTS green_news_runs_started_idx
    ON green_news_runs (started_at DESC);
