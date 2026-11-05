-- =============================================================================
-- E-373 — AI DIALER: DISPOSITIONS v3, PER-NUMBER COUNTERS, LONG-HORIZON REDIALS
--          (Priya KPI tracker tasks 6 + 8, 4 Nov 2026)
-- =============================================================================
-- WHY.
--   The KPI is complete conversations per 100 dials. Counting it needs one
--   disposition per DIAL — including the 47 of 100 that never connect — with the
--   SIP code and the agent's own verdict (answered_by, call_result). Until now
--   the SIP code lived only inside free text (call_outcome), answered_by and
--   call_result were read once and thrown away, and a failed trigger wrote no
--   disposition at all.
--
-- WHAT.
--   ai_dial_dispositions  one row per dial: L1 / L2 / L3 and the sheet rule that
--                         produced it (src/lib/ai-dialer/dispositionV3.ts), plus
--                         the evidence (SIP code, answered_by, call_result,
--                         callback_agreed, call_language, who ended the call and
--                         the raw termination reason) so a corrected rule can be
--                         re-run over history. dial_key = the conversation id, or
--                         'trigger:<campaign_lead_id>:<attempt>' for a dial the
--                         provider refused before a conversation existed.
--   dialer_number_stats   per phone (last ten digits): the reject streak (two
--                         "user disconnected" in a row = check our caller ID),
--                         dead-audio and intro-hang-up counts.
--   ai_redial_plan        re-attempts that outlive a campaign (Need Some Time 7 d,
--                         No requirement 30 d, Not Interested 90 d once …): the AI
--                         dialer does not redial the lead before due_at.
--
-- NEW TABLES, not columns on dealer_leads / dialer_campaign_leads: Drizzle names
-- every mirrored column in its SQL, so a column would make this migration
-- REQUIRED for every reader. NOT mirrored in schema.ts — raw SQL behind a
-- to_regclass probe (src/lib/ai/storage/dialDisposition.ts). Without the tables
-- the dialer behaves as before E-373, minus the stored dispositions.
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ai_dial_dispositions (
    dial_key         text         PRIMARY KEY,
    lead_id          text,
    campaign_id      text,
    phone_key        varchar(10),
    direction        varchar(10)  NOT NULL DEFAULT 'outbound',
    l1               varchar(20)  NOT NULL,
    l2               varchar(60)  NOT NULL,
    l3               varchar(60),
    rule_no          varchar(4)   NOT NULL,
    rules_version    varchar(30)  NOT NULL,
    sip_code         smallint,
    answered_by      varchar(40),
    call_result      varchar(40),
    callback_agreed  boolean,
    call_language    varchar(10),
    ended_by         varchar(10),
    end_reason_raw   text,
    duration_secs    numeric(8,2),
    effects          jsonb        NOT NULL DEFAULT '{}'::jsonb,
    dialled_at       timestamptz  NOT NULL DEFAULT now(),
    created_at       timestamptz  NOT NULL DEFAULT now(),
    updated_at       timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_dial_dispositions_dialled_idx
    ON ai_dial_dispositions (dialled_at DESC);
CREATE INDEX IF NOT EXISTS ai_dial_dispositions_lead_idx
    ON ai_dial_dispositions (lead_id, dialled_at DESC);
CREATE INDEX IF NOT EXISTS ai_dial_dispositions_campaign_idx
    ON ai_dial_dispositions (campaign_id, dialled_at DESC);

COMMENT ON TABLE ai_dial_dispositions IS
    'E-373: one Dispositions-v3 verdict per AI dial (src/lib/ai-dialer/dispositionV3.ts).';

CREATE TABLE IF NOT EXISTS dialer_number_stats (
    phone_key           varchar(10)  PRIMARY KEY,
    lead_id             text,
    reject_streak       integer      NOT NULL DEFAULT 0,
    caller_id_check_at  timestamptz,
    dead_audio_count    integer      NOT NULL DEFAULT 0,
    intro_hangup_count  integer      NOT NULL DEFAULT 0,
    last_l2             varchar(60),
    last_dial_at        timestamptz,
    updated_at          timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dialer_number_stats_caller_id_idx
    ON dialer_number_stats (caller_id_check_at)
    WHERE caller_id_check_at IS NOT NULL;

COMMENT ON TABLE dialer_number_stats IS
    'E-373: per-number AI dial counters (reject streak → caller-ID check, dead audio, intro hang-ups).';

CREATE TABLE IF NOT EXISTS ai_redial_plan (
    lead_id      text         PRIMARY KEY,
    due_at       timestamptz  NOT NULL,
    l3           varchar(60)  NOT NULL,
    once_only    boolean      NOT NULL DEFAULT false,
    used         boolean      NOT NULL DEFAULT false,
    source_dial  text,
    created_at   timestamptz  NOT NULL DEFAULT now(),
    updated_at   timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_redial_plan_due_idx ON ai_redial_plan (due_at);

COMMENT ON TABLE ai_redial_plan IS
    'E-373: re-attempts that outlive a campaign; the AI dialer will not redial lead_id before due_at.';
