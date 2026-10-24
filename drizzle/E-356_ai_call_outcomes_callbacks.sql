-- =============================================================================
-- E-356 — AI DIALER: ONE OUTCOME CATEGORY PER CALL + TRACKED CALLBACKS
--          (AI dialer review, 23 Oct 2026 — points 1, 2, 3, 5, 9)
-- =============================================================================
-- WHY.
--   * Every connected AI call looked the same: the campaign row only says the
--     dealer spoke ('completed'). The team needs the conversation outcome —
--     interested, callback (AI / sales), asked for a manager, not interested,
--     cut off mid-call … — per call, and counted per campaign.
--   * A dealer asking to be called back left the request only in the
--     transcript. Nothing owned it, nothing re-dialled it, nothing closed it.
--
-- WHAT.
--   1. ai_call_outcomes — one row per finished AI call (call_id = the provider's
--      id, same key as ai_call_logs.call_id). Written by
--      src/lib/ai/storage/callOutcomeStore.ts from both finalizers; read by the
--      campaign outcome report (src/lib/ai-dialer/campaignOutcomes.ts).
--      Vocabulary: src/lib/ai-dialer/callCategory.ts.
--   2. lead_callbacks — a callback the dealer asked for, until it is done.
--      owner_type 'ai' is re-dialled by the AI (src/lib/ai-dialer/aiCallbacks.ts,
--      behind AI_CALLBACKS_ENABLED); 'sales' is handed to the CRM (Ready to
--      assign → the existing assignment flow) and closed by the first logged
--      rep conversation. At most one open callback per lead (partial unique).
--
-- NOT mirrored in schema.ts — every reader/writer is raw SQL guarded by
-- to_regclass, so the code deploys safely before or after this file.
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ai_call_outcomes (
    call_id           text PRIMARY KEY,
    provider          varchar(20),
    lead_id           text,
    campaign_id       text,
    campaign_lead_id  text,
    category          varchar(40) NOT NULL,
    connected         boolean NOT NULL DEFAULT false,
    campaign_status   varchar(30),
    band              varchar(20),
    intent_score      integer,
    callback_owner    varchar(10),
    callback_topic    varchar(30),
    callback_due_at   timestamptz,
    wants_human       boolean NOT NULL DEFAULT false,
    will_retry        boolean NOT NULL DEFAULT false,
    retry_at          timestamptz,
    summary           text,
    rule_version      varchar(30),
    -- needs_review calls are re-scored in the background (at most 3 tries).
    rescore_attempts  integer NOT NULL DEFAULT 0,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_call_outcomes_campaign_idx
    ON ai_call_outcomes (campaign_id, category);
CREATE INDEX IF NOT EXISTS ai_call_outcomes_campaign_lead_idx
    ON ai_call_outcomes (campaign_lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_call_outcomes_lead_idx
    ON ai_call_outcomes (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_call_outcomes_needs_review_idx
    ON ai_call_outcomes (created_at) WHERE category = 'needs_review';

CREATE TABLE IF NOT EXISTS lead_callbacks (
    id                  text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    lead_id             text NOT NULL,
    source_call_id      text,
    campaign_id         text,
    provider            varchar(20),
    owner_type          varchar(10) NOT NULL,
    topic               varchar(30),
    category            varchar(40),
    requested_text      text,
    due_at              timestamptz NOT NULL,
    status              varchar(15) NOT NULL DEFAULT 'open',
    assigned_user_id    text,
    attempts            integer NOT NULL DEFAULT 0,
    last_call_id        text,
    last_dialed_at      timestamptz,
    summary             text,
    transcript_excerpt  text,
    completed_at        timestamptz,
    completed_by        text,
    completion_note     text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

DO $do$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_callbacks_owner_type_check') THEN
        ALTER TABLE lead_callbacks ADD CONSTRAINT lead_callbacks_owner_type_check
            CHECK (owner_type IN ('ai', 'sales'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_callbacks_status_check') THEN
        ALTER TABLE lead_callbacks ADD CONSTRAINT lead_callbacks_status_check
            CHECK (status IN ('open', 'dialing', 'done', 'cancelled', 'expired'));
    END IF;
END;
$do$;

-- One open callback per lead: a new request updates the open one.
CREATE UNIQUE INDEX IF NOT EXISTS lead_callbacks_one_open_per_lead
    ON lead_callbacks (lead_id) WHERE status IN ('open', 'dialing');
-- The AI re-dial claim scans due rows.
CREATE INDEX IF NOT EXISTS lead_callbacks_due_idx
    ON lead_callbacks (owner_type, status, due_at);
CREATE INDEX IF NOT EXISTS lead_callbacks_last_call_idx
    ON lead_callbacks (last_call_id) WHERE last_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lead_callbacks_campaign_idx
    ON lead_callbacks (campaign_id, status);
