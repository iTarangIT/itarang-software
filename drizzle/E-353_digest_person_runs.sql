-- =============================================================================
-- E-353 — ONE CLAIM PER PERSON FOR PERSONAL DIGESTS (tracker ID 194, "My day")
-- =============================================================================
--
-- WHY.
--   digest_runs claims one (kind, digest_date, slot) per send, and every
--   recipient of that send gets the same mail. "My day" is one email PER ISR /
--   ASM, each with their own numbers. With only the kind-level claim, a send
--   that failed for one person would either never be retried (slot marked
--   sent) or re-mail everyone on the retry (slot marked failed). So each
--   person gets their own claim here, with the same rules as digest_runs:
--   'sent' is terminal, 'failed' is retried while attempts < 3, a row stuck
--   in 'sending' is re-claimable after 15 minutes (src/lib/digests/engine.ts).
--
--   digest_runs still gets one summary row per slot, so the settings screen's
--   history and "last sent" keep working.
--
-- WHAT. New table digest_person_runs, unique (kind, digest_date, slot, user_id).
--   Test sends are not claimed and not stored here.
--
-- Mirrored in schema.ts (digestPersonRuns). The engine probes it with
-- to_regclass and skips a personal kind with a logged reason when it is
-- missing, so code on a database without this file sends nothing personal and
-- breaks nothing else.
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS digest_person_runs (
  id          bigserial PRIMARY KEY,
  kind        varchar(32)  NOT NULL,
  digest_date date         NOT NULL,
  slot        varchar(16)  NOT NULL,
  user_id     text         NOT NULL,
  email       text,
  status      varchar(16)  NOT NULL,
  attempts    integer      NOT NULL DEFAULT 0,
  message_id  text,
  error       text,
  claimed_at  timestamptz  NOT NULL DEFAULT now(),
  created_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS digest_person_runs_claim_uniq
  ON digest_person_runs (kind, digest_date, slot, user_id);

CREATE INDEX IF NOT EXISTS digest_person_runs_created_idx
  ON digest_person_runs (created_at);
