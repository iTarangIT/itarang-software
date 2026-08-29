-- E-250: the intent-review loop — human corrections that actually change the
--        lead, attached call recordings that get transcribed and scored, and a
--        calibration set the extraction prompt loads from the DB at runtime.
--
-- WHY
--   E-159 built half of this and stopped. A reviewer opens the campaign
--   transcript drawer, clicks "Correct this score", and an intent_score_feedback
--   row is written. Then nothing happens. The lead keeps its AI band, keeps
--   routing on the AI's score, and keeps showing the wrong number in every queue
--   and filter. The only consumer of the correction is an offline npm script
--   that a developer runs by hand.
--
--   Worse, the correction never reaches the model. Calibration examples — the
--   few-shot set that teaches the extractor what "yes" means — live in a
--   hand-authored TypeScript array (src/lib/ai/analysis/calibrationExamples.ts).
--   Teaching the AI anything requires an engineer to edit that file, bump
--   EXTRACTION_VERSION and redeploy. The loop's last mile is a person with
--   repository access, which is why it has never once closed.
--
--   Meanwhile the real reviewing happens in a Google Sheet. src/lib/google/sheet.ts
--   appends one Campaign_Call_Review row per call with a blank column per named
--   reviewer (CALL_REVIEWERS, sheet.ts:13). NOTHING in the repository ever reads
--   that tab back. Seven people have been filing feedback into a write-only sink
--   for months, which is exactly why docs/ai intent/eval/report.json still says
--   total: 2, accuracy: 0.
--
--   This migration is the storage half of closing all three gaps.
--
-- WHAT IT ADDS
--   1. intent_score_feedback      — widened: what the AI's BAND was (not just its
--                                   score), who reviewed and in what role, whether
--                                   the override was applied, and an idempotency
--                                   key so the Sheet import can be re-run.
--   2. lead_call_recordings (new) — an uploaded or re-fetched audio file, its
--                                   transcription lifecycle, and the signals/band
--                                   derived from it. This table IS the job queue.
--   3. intent_calibration_examples (new)
--                                 — admin-promoted teaching examples, read by the
--                                   extraction prompt at runtime.
--   4. ai_call_logs               — which prompt + example set produced the
--                                   signals, and the human band if one was set.
--   5. dealer_leads               — whether the live band is the AI's or a human's.
--
-- WHY THE OVERRIDE DOES NOT OVERWRITE ai_call_logs.band
--   That row is the AI's own record and the eval harness (scripts/intent) replays
--   it to measure agreement. Overwriting band with the human answer would make
--   the AI look perfect on every corrected call — the measurement would consume
--   its own correction and report 100% accuracy forever. So the human answer goes
--   in a SEPARATE column (human_band) and the AI's stays untouched. Same reason
--   E-159 snapshots original_intent_score/original_signals rather than pointing at
--   the live row.
--
-- WHY dealer_leads GETS intent_band_source AND NOT A SECOND BAND COLUMN
--   Every downstream reader — the /leads AI filters (E-249), the inside-sales and
--   ASM queues, the campaign table's Intent column, maybeReactivateOnRecall's
--   threshold check — already reads dealer_leads.intent_band / final_intent_score.
--   A parallel human_intent_band column would mean auditing and editing every one
--   of those readers, and any missed one would silently keep routing on the AI's
--   answer. So the override writes THROUGH to the existing columns and
--   intent_band_source records the provenance. Readers need no change; only the
--   UI reads the new column, to label the number.
--
-- WHY status ON lead_call_recordings IS A PLAIN varchar WITH NO CHECK
--   Per this table family's convention (E-202, E-218, E-220, E-221, E-226, E-230,
--   E-231, E-232, E-237, E-238, E-241): the vocabulary lives in the TypeScript
--   write path and is enforced by zod. A CHECK here turns a vocabulary extension
--   into a migration on every database.
--
-- WHY THE RECORDINGS TABLE IS ITS OWN QUEUE
--   E-241 needed a separate scraper_job_queue because the work item (a query+city
--   pair) had no row of its own. Here it does: one uploaded recording IS one
--   transcription job, one-to-one, forever. A second table would be a join with no
--   cardinality behind it. So status/attempts/claimed_at/next_attempt_at live on
--   the recording itself and the ticker claims from it with FOR UPDATE SKIP
--   LOCKED, exactly as jobQueue.dispatchOnce() does.
--
-- WHY external_key IS A PARTIAL UNIQUE INDEX
--   Only Sheet-imported rows carry one; app corrections are append-only by design
--   (E-159: "a re-correction of the same call inserts a new row") and leave it
--   NULL. Postgres treats NULLs as distinct, so a plain UNIQUE would also be
--   correct — partial is chosen so the index carries only the imported rows
--   instead of one dead entry per correction forever.
--   ⚠ ON CONFLICT against this index MUST repeat the WHERE predicate
--   (ON CONFLICT (external_key) WHERE external_key IS NOT NULL) or Postgres will
--   not match it and the statement errors with "no unique or exclusion constraint
--   matching the ON CONFLICT specification".
--
-- REQUIRED?
--   YES for the intent-review feature. Every /api/dealer-leads/[id]/intent-feedback
--   write, the recordings upload route, the transcription ticker and the
--   /admin/ai-intent console read or write these. The pre-existing E-159 drawer
--   correction keeps working without it (it only writes the old columns), and the
--   AI dialer itself is untouched.
--
-- Additive, idempotent, and safe to re-run. No column is dropped, no type is
-- narrowed, nothing is retroactively SET NOT NULL.
-- Apply via pgAdmin Query Tool (never db:push).

BEGIN;

-- ── 1. intent_score_feedback — widen the correction record ───────────────────
-- The table itself is E-159. Guarded so this file is still a clean no-op on a
-- database where E-159 has not been applied yet (it raises a notice instead of
-- aborting the whole migration).
DO $do$
BEGIN
    ALTER TABLE intent_score_feedback
        ADD COLUMN IF NOT EXISTS ai_band          varchar(20),
        ADD COLUMN IF NOT EXISTS reviewer_role    varchar(50),
        ADD COLUMN IF NOT EXISTS review_kind      varchar(20)  NOT NULL DEFAULT 'correction',
        ADD COLUMN IF NOT EXISTS source           varchar(20)  NOT NULL DEFAULT 'app',
        ADD COLUMN IF NOT EXISTS external_key     text,
        ADD COLUMN IF NOT EXISTS recording_id     uuid,
        ADD COLUMN IF NOT EXISTS agreed           boolean,
        ADD COLUMN IF NOT EXISTS applied_to_lead  boolean      NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS applied_at       timestamptz;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'E-250: intent_score_feedback missing (apply E-159 first) — skipping section 1';
END;
$do$;

COMMENT ON COLUMN intent_score_feedback.ai_band IS
    'E-250: the band the AI produced for this call (Qualified|Warm|Cold|Disqualified), '
    'snapshotted at correction time. E-159 captured original_intent_score but not the '
    'band, so "did the human agree" could only be reconstructed by re-deriving the '
    'band from the score — which stops working the moment BAND_LEAD_SCORE changes.';

COMMENT ON COLUMN intent_score_feedback.reviewer_role IS
    'E-250: the reviewer''s users.role AT REVIEW TIME. Stored rather than joined '
    'because roles change: an ASM promoted to sales_head would retroactively rewrite '
    'the provenance of every correction they ever made.';

COMMENT ON COLUMN intent_score_feedback.review_kind IS
    'E-250: correction | note. ''correction'' carries a real human label in '
    'corrected_status and is eligible for the golden set. ''note'' is free-text '
    'commentary with no parseable band — produced by the Google Sheet import, whose '
    'reviewer columns are prose. Every consumer (eval harness, golden export, the '
    '"Corrected" pill) filters to ''correction'' so notes never fabricate ground truth.';

COMMENT ON COLUMN intent_score_feedback.source IS
    'E-250: app | sheet_import. Distinguishes a correction made in the CRM from one '
    'back-filled out of the retired Campaign_Call_Review Google Sheet, so an eval run '
    'can weight or exclude the imported history.';

COMMENT ON COLUMN intent_score_feedback.external_key IS
    'E-250: idempotency key for imported rows, ''sheet:<call_id>:<reviewer>''. NULL for '
    'app corrections, which are append-only by design. See the partial unique index '
    'below and the ON CONFLICT warning in this file''s header.';

COMMENT ON COLUMN intent_score_feedback.recording_id IS
    'E-250: lead_call_recordings.id when the reviewer attached audio instead of typing '
    'an explanation. Soft FK, no DB-level constraint — a deleted recording should '
    'leave a dangling id somebody can repair, not block the correction.';

COMMENT ON COLUMN intent_score_feedback.agreed IS
    'E-250: did the human land on the same band as the AI. Stored rather than computed '
    'so the /admin/ai-intent disagreement queue is an index scan instead of a '
    'case-expression over every row, and so it stays true to the comparison made at '
    'the time even if the band vocabulary is later extended.';

COMMENT ON COLUMN intent_score_feedback.applied_to_lead IS
    'E-250: whether this correction was written THROUGH to dealer_leads (the override) '
    'or recorded as training data only. False for imported Sheet history — that is '
    'months-old commentary about calls that have since moved on, and replaying it onto '
    'live leads would rewrite the pipeline from an archive.';

-- Idempotency for the Sheet import. Partial so the index carries only imported
-- rows rather than one entry per correction forever.
CREATE UNIQUE INDEX IF NOT EXISTS intent_score_feedback_external_key_idx
    ON intent_score_feedback (external_key)
    WHERE external_key IS NOT NULL;

-- The /admin/ai-intent disagreement queue: "corrections where the human
-- overruled the AI, newest first". Partial on the exact predicate that queue
-- uses, because disagreements are the minority of rows and the whole point of
-- the console is to surface them fast.
CREATE INDEX IF NOT EXISTS intent_score_feedback_disagreement_idx
    ON intent_score_feedback (created_at DESC)
    WHERE agreed IS FALSE AND review_kind = 'correction';

-- ── 2. lead_call_recordings — attached audio + its transcription job ─────────
CREATE TABLE IF NOT EXISTS lead_call_recordings (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id             varchar(255) NOT NULL,
    call_id             varchar(255),
    purpose             varchar(20) NOT NULL DEFAULT 'human_call',

    -- Where the bytes are
    s3_key              text        NOT NULL,
    content_type        varchar(100),
    size_bytes          bigint,
    duration_sec        integer,
    original_filename   text,

    -- Transcription lifecycle — this table IS the queue
    status              varchar(20) NOT NULL DEFAULT 'pending',
    attempts            integer     NOT NULL DEFAULT 0,
    claimed_at          timestamptz,
    next_attempt_at     timestamptz NOT NULL DEFAULT now(),
    error               text,

    -- What came back
    transcript          text,
    transcript_segments jsonb,
    language            varchar(20),
    transcribe_model    varchar(50),

    -- What the scoring engine made of it
    signals             jsonb,
    score_breakdown     jsonb,
    band                varchar(20),
    intent_score        integer,
    info_signals_count  integer,
    call_summary        text,
    scoring_version     varchar(20),
    extraction_version  varchar(20),

    uploaded_by         uuid,
    created_at          timestamptz NOT NULL DEFAULT now(),
    transcribed_at      timestamptz
);

COMMENT ON TABLE lead_call_recordings IS
    'E-250: one audio file attached to a dealer lead, plus its transcription job and '
    'the signals/band derived from it. Drained by startRecordingTranscriptionTicker() '
    'in src/instrumentation-node.ts. Deliberately its own queue — one recording is one '
    'job, one-to-one, so a separate job table would be a join with no cardinality.';

COMMENT ON COLUMN lead_call_recordings.lead_id IS
    'E-250: dealer_leads.id. Soft FK and varchar to match that table''s text id, the '
    'same shape ai_call_logs.lead_id uses.';

COMMENT ON COLUMN lead_call_recordings.call_id IS
    'E-250: ai_call_logs.call_id when this audio belongs to an existing AI call — set '
    'for purpose=''ai_reanalysis'', and for ''evidence'' attached to a specific call. '
    'NULL for a human follow-up the dialer never made.';

COMMENT ON COLUMN lead_call_recordings.purpose IS
    'E-250: human_call | ai_reanalysis | evidence. '
    '''human_call'' — a follow-up the user recorded on their own phone: transcribe it '
    'and score it through the SAME analyzeTranscript() the dialer uses, so a human '
    'call and an AI call are graded identically. '
    '''ai_reanalysis'' — the Bolna transcript was garbled or empty; re-transcribe the '
    'stored audio and re-extract rather than trusting the provider''s text. '
    '''evidence'' — stored and playable as proof behind a correction, never transcribed '
    '(it goes straight to status=''skipped'').';

COMMENT ON COLUMN lead_call_recordings.s3_key IS
    'E-250: key under the ''call-recordings'' LOGICAL bucket (a key prefix in the one '
    'physical AWS_S3_BUCKET — see src/lib/storage/s3.ts). Served back through '
    '/api/files/call-recordings/<key>, which is already an allowed AND auth-required '
    'bucket, so no new serving route was needed.';

COMMENT ON COLUMN lead_call_recordings.size_bytes IS
    'E-250: enforced at 25 MB on upload. Not an arbitrary cap — OpenAI''s transcription '
    'endpoint rejects anything larger, so a bigger file could be stored but never '
    'transcribed. At ~64 kbps m4a that is roughly 50 minutes, longer than any call in '
    'this corpus.';

COMMENT ON COLUMN lead_call_recordings.status IS
    'E-250: pending | running | done | failed | skipped. No CHECK and no enum — the '
    'vocabulary lives in src/lib/ai/transcription/ and is enforced by zod at the write '
    'path, per this table family''s convention (cf. E-226/E-231/E-237/E-241). '
    '''skipped'' is the terminal state for purpose=''evidence''.';

COMMENT ON COLUMN lead_call_recordings.next_attempt_at IS
    'E-250: earliest instant the ticker may claim this row. Always compared against '
    'Postgres now() and always SET from now() + an interval in SQL — never from a JS '
    'Date. Two independent reasons: pm2 VPS clock drift (src/lib/nbfc/auction/scheduler.ts '
    'records what that cost), and a JS Date interpolated into a raw drizzle sql`` '
    'template throws ERR_INVALID_ARG_TYPE at runtime.';

COMMENT ON COLUMN lead_call_recordings.attempts IS
    'E-250: incremented inside the claim, before the work runs. A row that keeps '
    'crashing the transcriber therefore backs off and eventually stops being claimed, '
    'instead of being retried forever at 30s intervals.';

COMMENT ON COLUMN lead_call_recordings.transcript_segments IS
    'E-250: timestamped segments, when the model returns them. NULL under the default '
    'gpt-4o-transcribe, which emits text only; populated when INTENT_TRANSCRIBE_MODEL '
    'is set to whisper-1, which supports verbose_json. The UI renders a plain '
    'transcript when this is NULL and a timeline when it is not.';

COMMENT ON COLUMN lead_call_recordings.band IS
    'E-250: the band computeBand() derived from this recording''s transcript. Note this '
    'is the recording''s OWN band — attaching audio does not silently move the lead. A '
    'human still has to accept it by submitting a correction.';

COMMENT ON COLUMN lead_call_recordings.extraction_version IS
    'E-250: EXTRACTION_VERSION plus the calibration-set hash in force when this '
    'recording was analysed, so a past result can be traced to the exact prompt that '
    'produced it now that the example set changes without a deploy.';

-- The ticker's claim: WHERE status='pending' AND next_attempt_at <= now()
-- ORDER BY next_attempt_at LIMIT n FOR UPDATE SKIP LOCKED. Partial, because
-- pending rows are a shrinking minority and this predicate is probed every 30s.
CREATE INDEX IF NOT EXISTS lead_call_recordings_claim_idx
    ON lead_call_recordings (next_attempt_at)
    WHERE status = 'pending';

-- The review panel: every recording on one lead, newest first.
CREATE INDEX IF NOT EXISTS lead_call_recordings_lead_idx
    ON lead_call_recordings (lead_id, created_at DESC);

-- Re-analysis joins back from the AI call.
CREATE INDEX IF NOT EXISTS lead_call_recordings_call_idx
    ON lead_call_recordings (call_id)
    WHERE call_id IS NOT NULL;

-- ── 3. intent_calibration_examples — the DB-driven few-shot set ──────────────
CREATE TABLE IF NOT EXISTS intent_calibration_examples (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    why                 text        NOT NULL,
    transcript          text        NOT NULL,
    signals             jsonb       NOT NULL,
    active              boolean     NOT NULL DEFAULT true,
    sort_order          integer     NOT NULL DEFAULT 100,
    source_feedback_id  uuid,
    source_call_id      varchar(255),
    extraction_version  varchar(20),
    created_by          uuid,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE intent_calibration_examples IS
    'E-250: admin-promoted few-shot examples injected into the extraction prompt at '
    'RUNTIME (src/lib/ai/analysis/calibrationStore.ts), replacing the hand-authored '
    'array in calibrationExamples.ts as the source of new teaching. That array remains '
    'as the built-in SEED — the loader falls back to it whenever this table is empty or '
    'unreachable, so a DB problem degrades the prompt to today''s behaviour instead of '
    'sending an example-less prompt to the model.';

COMMENT ON COLUMN intent_calibration_examples.why IS
    'E-250: the one-line rationale shown TO THE MODEL as the example''s heading (it is '
    'part of the prompt, not an internal note). Written by the curator when promoting a '
    'correction — this is the sentence that actually does the teaching.';

COMMENT ON COLUMN intent_calibration_examples.signals IS
    'E-250: the CORRECT QualificationSignals for this transcript, shaped like '
    'ai_call_logs.signals. Prefilled from the promoted correction''s corrected_signals '
    'and editable by the curator before saving.';

COMMENT ON COLUMN intent_calibration_examples.active IS
    'E-250: only active rows enter the prompt. Deactivating is the instant undo for a '
    'bad example — it takes effect on the next cache expiry with no deploy, which is '
    'the whole reason this set moved out of TypeScript.';

COMMENT ON COLUMN intent_calibration_examples.sort_order IS
    'E-250: prompt order, ascending. Matters because few-shot examples are read in '
    'sequence and the last ones carry the most weight; the curator controls which rule '
    'the model sees last.';

COMMENT ON COLUMN intent_calibration_examples.source_feedback_id IS
    'E-250: the intent_score_feedback row this was promoted from. Soft FK. Keeps the '
    'audit trail from "a reviewer said the AI was wrong" through to "the prompt now '
    'teaches that case".';

CREATE INDEX IF NOT EXISTS intent_calibration_examples_active_idx
    ON intent_calibration_examples (sort_order, created_at)
    WHERE active;

-- ── 4. ai_call_logs — prompt provenance + the human answer ───────────────────
DO $do$
BEGIN
    ALTER TABLE ai_call_logs
        ADD COLUMN IF NOT EXISTS extraction_version   varchar(40),
        ADD COLUMN IF NOT EXISTS calibration_set_hash varchar(64),
        ADD COLUMN IF NOT EXISTS human_band           varchar(20),
        ADD COLUMN IF NOT EXISTS human_reviewed_by    uuid,
        ADD COLUMN IF NOT EXISTS human_reviewed_at    timestamptz;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'E-250: ai_call_logs missing — skipping section 4';
END;
$do$;

COMMENT ON COLUMN ai_call_logs.extraction_version IS
    'E-250: EXTRACTION_VERSION (src/lib/ai/scoring/version.ts) in force when signals '
    'were extracted. Its counterpart scoring_version already recorded which BAND RULE '
    'ran; this records which PROMPT ran, so an audit can tell whether a shift came from '
    'a new rule or new teaching.';

COMMENT ON COLUMN ai_call_logs.calibration_set_hash IS
    'E-250: hash of the active calibration example ids + their signals at extraction '
    'time. Once the example set can change without a deploy, EXTRACTION_VERSION alone '
    'stops identifying the prompt — two calls can share a version and have been scored '
    'by different examples. This is what makes a past score reproducible.';

COMMENT ON COLUMN ai_call_logs.human_band IS
    'E-250: the band a reviewer says this call really was. Deliberately SEPARATE from '
    'band, which stays the AI''s answer forever — overwriting it would let the eval '
    'harness replay the human''s own correction as if the AI had produced it and report '
    '100% agreement.';

-- ── 5. dealer_leads — is the live band the AI's or a human's ─────────────────
DO $do$
BEGIN
    ALTER TABLE dealer_leads
        ADD COLUMN IF NOT EXISTS intent_band_source   varchar(10) NOT NULL DEFAULT 'ai',
        ADD COLUMN IF NOT EXISTS intent_overridden_by uuid,
        ADD COLUMN IF NOT EXISTS intent_overridden_at timestamptz;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'E-250: dealer_leads missing — skipping section 5';
END;
$do$;

COMMENT ON COLUMN dealer_leads.intent_band_source IS
    'E-250: ai | human. Provenance of the CURRENT intent_band / final_intent_score. '
    'The override writes THROUGH to those existing columns rather than adding parallel '
    'ones, so every existing reader (the /leads AI filters, the inside-sales and ASM '
    'queues, the campaign Intent column, maybeReactivateOnRecall''s threshold) picks up '
    'the corrected value with no change. Only the UI reads this column, to label the '
    'number as human-corrected. '
    'PRECEDENCE: a NEWER call resets this to ''ai'' — newer evidence beats an older '
    'human judgement, matching what leadStore.updateLeadAfterCall already does. A '
    'dropped_empty call writes nothing at all and so can never wipe an override.';

COMMIT;
