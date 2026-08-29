-- E-267 — ai_call_logs.transcript_turns jsonb: keep the SHAPE of a call, not
-- just its words.
--
-- ONE COLUMN, additive, nullable, no backfill, no index.
--
-- WHAT IS BEING LOST TODAY
--   ElevenLabs hands us the conversation as an array of turns, and every turn
--   carries `time_in_call_secs` alongside its role and message. Both places that
--   receive it -- elevenlabs/webhookHandler.ts and elevenlabs/getCallStatus.ts --
--   immediately flatten that array to `"<speaker>: <message>"` lines joined by
--   newlines, and the timings are discarded at that step. They are not stored
--   anywhere else: no raw payload is retained, so once the string is written the
--   timing is gone for good.
--
--   The raw array ALREADY travels as far as finalizeElevenLabsCall (the
--   `conversation` field of ElevenLabsFinalizePayload). It reaches the writer and
--   is dropped on the floor. This column is where it lands.
--
-- WHAT IT UNLOCKS
--   "How long did the dealer wait before hanging up?" — the one question of the
--   nine the campaign call-quality panel asks that stored data cannot answer.
--   Answering it needs the gap between turns, which needs per-turn timings.
--
--   Secondarily it makes the flat string a DERIVED view rather than the source
--   of truth. call-quality/transcript.ts currently re-parses that string with a
--   continuation-safe reader, because a turn message containing a newline is
--   indistinguishable from a new turn once flattened. With the array stored,
--   that ambiguity does not arise for new calls.
--
-- WHY NOT REPLACE `transcript`
--   The string column is read by the transcript drawer, the Excel export, the
--   analysis prompt and the scoring harness. Rewriting all four is not this
--   change, and doing it in the same migration would make a reversible column
--   addition into an irreversible one. Both columns coexist; the string stays
--   authoritative for everything that reads it today.
--
-- NO BACKFILL IS POSSIBLE and none is attempted. The 83 historical transcripts
-- were flattened before this column existed and their timings are unrecoverable.
-- The parser falls back to reading the string whenever this column is null, so
-- history keeps working unchanged and only the timing metric is dark for it.
--
-- ⚠ `time_in_call_secs` IS OPTIONAL IN THE PROVIDER'S PAYLOAD and has never been
-- read by this codebase, so whether it is actually populated could not be
-- verified before writing this. That is deliberately made harmless: the turns
-- are stored VERBATIM whatever fields they carry, and the response-time metric
-- renders only when timings are present. If ElevenLabs never sends them, this
-- column still supersedes the lossy string and one UI tile stays dark. The
-- application logs whether timings arrived on the first live call rather than
-- assuming.
--
-- NO INDEX, deliberately, matching the reasoning recorded for `signals` in
-- E-249: ai_call_logs held ~300 rows / 83 with a transcript when this was
-- written, so a GIN would index a handful of documents to accelerate a
-- two-page scan and would never be planned. Every read is a whole-campaign
-- scan already filtered by call_id. Revisit at ~50k rows.
--
-- SAFE TO SKIP AT DEPLOY TIME: YES, and that took a deliberate decision.
--
--   The obvious shape — mirror the column on `aiCallLogs` in schema.ts — makes
--   this file REQUIRED, because Drizzle names every column of a mirrored table
--   in its generated SQL. There are 21 aiCallLogs call sites, including three
--   bare `db.insert()` on the call-finalize path itself, so an unapplied E-267
--   would fail EVERY finalized AI call with `column "transcript_turns" does not
--   exist`. With no migration auto-runner here and per-environment ticks that
--   are known to drift in both directions, that trades one dark metric for the
--   entire AI call-logging pipeline.
--
--   So the column is deliberately ABSENT from schema.ts — the rule E-250,
--   E-242, E-224 and E-236 already follow — and is written instead by a guarded
--   raw UPDATE in elevenlabs/finalizeCall.ts (`persistTranscriptTurns`). That
--   statement catches SQLSTATE 42703 and logs a one-line notice pointing at this
--   file, so an unapplied E-267 costs exactly the feature that needs it and
--   nothing else.
--
-- Additive and idempotent. Verify with:
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'ai_call_logs' AND column_name = 'transcript_turns';
--   SELECT count(*) FILTER (WHERE transcript_turns IS NOT NULL) AS with_turns,
--          count(*) FILTER (WHERE transcript_turns IS NOT NULL
--                             AND transcript_turns @> '[{}]'::jsonb) AS parsed
--     FROM ai_call_logs;

BEGIN;

DO $do$
BEGIN
    ALTER TABLE ai_call_logs
        ADD COLUMN IF NOT EXISTS transcript_turns jsonb;
EXCEPTION
    WHEN undefined_table THEN
        RAISE NOTICE 'skip E-267: ai_call_logs not present';
END;
$do$;

DO $do$
BEGIN
    COMMENT ON COLUMN ai_call_logs.transcript_turns IS
        'E-267. The provider''s conversation array VERBATIM: one object per turn, '
        'carrying at least {role, message} and, when the provider sends it, '
        '{time_in_call_secs}. The flat `transcript` column is the same content '
        'stringified as "<speaker>: <message>" lines and remains authoritative '
        'for the drawer, the export, the analysis prompt and the scoring '
        'harness. NULL for every call finalized before E-267 — those timings are '
        'unrecoverable, and call-quality/transcript.ts falls back to parsing the '
        'string. ElevenLabs only; the legacy Bolna path does not populate it.';
EXCEPTION
    WHEN undefined_table OR undefined_column THEN
        RAISE NOTICE 'skip E-267 comment: column not present';
END;
$do$;

COMMIT;
