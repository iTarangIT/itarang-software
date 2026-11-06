-- =============================================================================
-- E-376 — AI DIALER: INBOUND CALLS ON THE VOBIZ NUMBER (Priya KPI tracker task 9)
-- =============================================================================
-- WHY.
--   29 dealers called the Vobiz number back between 21 Oct and 4 Nov (6.6 per
--   100 dials) and every one was rejected at 0 s. They called because they
--   wanted the conversation. The agent owner is switching the number to a
--   callback agent; the CRM's part is to recognise the caller, hand the agent
--   the context (open callback, its ISR, the last outcome), log every inbound
--   on the lead and on its open callback, and get an unanswered one returned
--   within 10 minutes.
--
-- WHAT. inbound_calls — one row per inbound call:
--   call_sid / conversation_id   ElevenLabs' ids (the init webhook only has
--                                the call_sid; the post-call adds the other)
--   caller_phone, phone_key      as the carrier gave it, and its last 10 digits
--   lead_id, callback_id         the matched lead and its open callback
--   branch                       confirm_slot | do_it_now | warm_opener |
--                                complaint | unknown — what the agent was told
--   answered                     a person spoke on it (null until post-call)
--   return_due_at, returned_at   the 10-minute return task for a missed one
--   handled_at                   the post-call (or the missed-call sweep) ran
--
-- A new raw-SQL table behind to_regclass (src/lib/ai-dialer/inbound.ts), NOT
-- mirrored in schema.ts: without it the init webhook still answers with the
-- context, only nothing is logged. Strictly additive, idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS inbound_calls (
    id               text         PRIMARY KEY DEFAULT ('inb_' || replace(gen_random_uuid()::text, '-', '')),
    call_sid         text,
    conversation_id  text,
    caller_phone     text         NOT NULL,
    phone_key        varchar(10),
    lead_id          text,
    callback_id      text,
    branch           varchar(20)  NOT NULL DEFAULT 'unknown',
    answered         boolean,
    return_due_at    timestamptz,
    returned_at      timestamptz,
    handled_at       timestamptz,
    created_at       timestamptz  NOT NULL DEFAULT now(),
    updated_at       timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS inbound_calls_conversation_uniq
    ON inbound_calls (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbound_calls_call_sid_idx
    ON inbound_calls (call_sid) WHERE call_sid IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbound_calls_phone_idx
    ON inbound_calls (phone_key, created_at DESC);
CREATE INDEX IF NOT EXISTS inbound_calls_lead_idx
    ON inbound_calls (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inbound_calls_unhandled_idx
    ON inbound_calls (created_at) WHERE handled_at IS NULL;

COMMENT ON TABLE inbound_calls IS
    'E-376: calls dealers make to the Vobiz number (Priya KPI task 9); src/lib/ai-dialer/inbound.ts.';
