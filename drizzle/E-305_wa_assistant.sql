-- =============================================================================
-- E-305 — WHATSAPP SALES ASSISTANT: binding, conversation, actions, logs (2026-09-24)
-- =============================================================================
-- WHY. CRM AI Assistant Phase 1 (docs/ai-assistant-whatsapp BRD, 24 Sep 2026):
-- ASMs and ISRs message a dedicated WhatsApp number; the Assistant reads their
-- CRM data within their permissions and proposes writes that run only when the
-- rep taps Confirm. It is a separate flow from the dealer bot and shares none of
-- its tables (whatsapp_messages, whatsapp_dealer_sessions, …).
-- Plan: docs/wa-assistant/PLAN.md.
--
-- WHAT CHANGED (additive; five NEW tables, nothing existing touched):
--
--   assistant_wa_bindings    user ↔ WhatsApp number. Pending LINK codes are
--                            rows with status='pending' (HMAC of the code, never
--                            the code); verifying one turns that row 'active'.
--                            At most one active row per user AND per number.
--   assistant_conversations  last 20 turns per user (jsonb), plus the per-user
--                            turn lease (lease_token / lease_until) that runs a
--                            user's messages one at a time.
--   assistant_actions        every proposed write: pending → executing →
--                            confirmed | failed; or cancelled / expired; or
--                            escalated (a high-impact Lost that needed a second
--                            Confirm, which is a new step=2 row). before/after
--                            values, the lead version the preview was built on,
--                            10-minute expiry, run-once.
--   assistant_wa_messages    inbound + outbound log. provider_message_id UNIQUE
--                            is the inbound dedupe; `handling` records what the
--                            router did with each message (the audit trail and
--                            the LINK lock-out counter).
--   assistant_tool_calls     every agent tool call: input + truncated output.
--
-- user_id is uuid (users.id). Live-state tables reference users; the two log
-- tables deliberately do not, so a log row can never block or vanish with a user.
--
-- No backfill. Required before the Assistant code deploys; nothing else reads
-- these tables, so old code on a new DB is unaffected and the order of this
-- migration vs. any other is irrelevant.
--
-- Idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS assistant_wa_bindings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users(id),
    wa_phone        text,
    status          varchar(10) NOT NULL,
    code_hash       text,
    code_expires_at timestamptz,
    verified_at     timestamptz,
    revoked_at      timestamptz,
    revoked_reason  varchar(40),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT assistant_wa_bindings_status_chk
        CHECK (status IN ('pending', 'active', 'revoked')),
    CONSTRAINT assistant_wa_bindings_active_has_phone
        CHECK (status <> 'active' OR wa_phone IS NOT NULL),
    CONSTRAINT assistant_wa_bindings_pending_has_code
        CHECK (status <> 'pending' OR (code_hash IS NOT NULL AND code_expires_at IS NOT NULL)),
    CONSTRAINT assistant_wa_bindings_phone_e164
        CHECK (wa_phone IS NULL OR wa_phone ~ '^\+[1-9][0-9]{7,14}$')
);

-- One active number per user, one active user per number (BRD §5 binding rules).
CREATE UNIQUE INDEX IF NOT EXISTS assistant_wa_bindings_active_user_uniq
    ON assistant_wa_bindings (user_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS assistant_wa_bindings_active_phone_uniq
    ON assistant_wa_bindings (wa_phone) WHERE status = 'active';
-- One outstanding code per user; codes unique among outstanding ones, so a
-- LINK message resolves to at most one user.
CREATE UNIQUE INDEX IF NOT EXISTS assistant_wa_bindings_pending_user_uniq
    ON assistant_wa_bindings (user_id) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS assistant_wa_bindings_pending_code_uniq
    ON assistant_wa_bindings (code_hash) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS assistant_conversations (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          uuid NOT NULL REFERENCES users(id),
    channel          varchar(20) NOT NULL DEFAULT 'whatsapp',
    messages         jsonb NOT NULL DEFAULT '[]'::jsonb,
    last_activity_at timestamptz NOT NULL DEFAULT now(),
    lease_token      uuid,
    lease_until      timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT assistant_conversations_channel_chk CHECK (channel IN ('whatsapp'))
);

CREATE UNIQUE INDEX IF NOT EXISTS assistant_conversations_user_channel_uniq
    ON assistant_conversations (user_id, channel);

CREATE TABLE IF NOT EXISTS assistant_actions (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid NOT NULL REFERENCES users(id),
    channel           varchar(20) NOT NULL DEFAULT 'whatsapp',
    tool              varchar(40) NOT NULL,
    lead_id           text,
    lead_version      timestamptz,
    input             jsonb NOT NULL,
    preview           jsonb NOT NULL,
    before            jsonb,
    after             jsonb,
    status            varchar(12) NOT NULL DEFAULT 'pending',
    step              smallint NOT NULL DEFAULT 1,
    parent_action_id  uuid REFERENCES assistant_actions(id),
    expires_at        timestamptz NOT NULL,
    executed_at       timestamptz,
    error             text,
    wa_message_id     text,
    source_message_id uuid,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT assistant_actions_status_chk CHECK (status IN
        ('pending', 'executing', 'confirmed', 'cancelled', 'expired', 'failed', 'escalated')),
    CONSTRAINT assistant_actions_step_chk CHECK (step IN (1, 2)),
    CONSTRAINT assistant_actions_channel_chk CHECK (channel IN ('whatsapp'))
);

CREATE INDEX IF NOT EXISTS assistant_actions_user_status_idx
    ON assistant_actions (user_id, status);
-- The expiry sweep and the stuck-'executing' recovery.
CREATE INDEX IF NOT EXISTS assistant_actions_open_expiry_idx
    ON assistant_actions (status, expires_at) WHERE status IN ('pending', 'executing');

CREATE TABLE IF NOT EXISTS assistant_wa_messages (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_message_id text,
    direction           varchar(3) NOT NULL,
    type                varchar(20) NOT NULL,
    user_id             uuid,
    wa_phone            text NOT NULL,
    phone_number_id     text,
    text                varchar(2000),
    handling            varchar(30),
    delivery_status     varchar(12),
    action_id           uuid,
    raw_payload         jsonb,
    error               text,
    handled_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT assistant_wa_messages_direction_chk CHECK (direction IN ('in', 'out'))
);

-- Inbound dedupe (a duplicate Meta delivery conflicts here) and the status
-- receipts' lookup of the outbound row. NULL for a send that failed before Meta
-- returned an id; NULLs never conflict.
CREATE UNIQUE INDEX IF NOT EXISTS assistant_wa_messages_provider_id_uniq
    ON assistant_wa_messages (provider_message_id);
-- LINK lock-out (failed attempts per number per hour) and per-number review.
CREATE INDEX IF NOT EXISTS assistant_wa_messages_phone_created_idx
    ON assistant_wa_messages (wa_phone, created_at);
CREATE INDEX IF NOT EXISTS assistant_wa_messages_user_created_idx
    ON assistant_wa_messages (user_id, created_at);
-- The "stuck turn" review: inbound rows the router never finished.
CREATE INDEX IF NOT EXISTS assistant_wa_messages_unhandled_idx
    ON assistant_wa_messages (created_at) WHERE direction = 'in' AND handled_at IS NULL;

CREATE TABLE IF NOT EXISTS assistant_tool_calls (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL,
    message_id  uuid,
    tool        varchar(40) NOT NULL,
    input       jsonb,
    output      jsonb,
    ok          boolean NOT NULL,
    error       text,
    latency_ms  integer,
    action_id   uuid,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assistant_tool_calls_user_created_idx
    ON assistant_tool_calls (user_id, created_at);
