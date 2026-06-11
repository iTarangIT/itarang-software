-- E-167 — WhatsApp dealer-onboarding chatbot (Phase 1: full vertical slice).
--
-- Additive + idempotent. WhatsApp is the *collection channel*; the existing
-- Sales Admin review panel remains the *approval authority*. The bot writes into
-- the SAME onboarding tables the web wizard uses (dealer_onboarding_applications /
-- dealer_onboarding_documents) so a WhatsApp-collected dealer shows up in the
-- normal admin review list — flagged source='whatsapp'. See
-- docs/plans/dealer-whatsapp-onboarding-system-design.md.
--
-- This migration adds:
--   1. whatsapp_onboarding_sessions  — one row per dealer conversation; drives the
--      state machine + resume.
--   2. whatsapp_messages             — append-only inbound/outbound log = audit +
--      idempotency (provider_message_id UNIQUE) + delivery tracking.
--   3. additive columns on the two existing onboarding tables (source badge,
--      WhatsApp linkage, extraction/verification metadata).
--
-- current_state / session_status / direction / message_type are intentionally NOT
-- CHECK-constrained — the state set is code-owned (src/lib/whatsapp/orchestrator.ts)
-- so adding a state never needs a migration. Mirror every change in
-- src/lib/db/schema.ts.

-- ── 1. Sessions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS whatsapp_onboarding_sessions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_phone                  varchar(20) NOT NULL,        -- dealer E.164 (no '+')
  wa_contact_name           text,                        -- WhatsApp profile name
  provider                  varchar(16) NOT NULL DEFAULT 'meta', -- meta | interakt | gupshup
  provider_conversation_id  text,                        -- provider thread/contact id
  application_id            uuid REFERENCES dealer_onboarding_applications(id),
  current_state             varchar(32) NOT NULL DEFAULT 'GREETING',
  expected_document_type    varchar(64),                 -- doc the bot is waiting for
  detected_company_type     varchar(48),                 -- sole_proprietorship | partnership_firm | private_limited_firm | llp
  language                  varchar(12) NOT NULL DEFAULT 'en', -- en | hi | hinglish
  context                   jsonb NOT NULL DEFAULT '{}'::jsonb, -- collected answers + checklist progress
  reminder_count            integer NOT NULL DEFAULT 0,
  last_inbound_at           timestamptz,
  last_outbound_at          timestamptz,
  last_reminder_at          timestamptz,
  session_status            varchar(24) NOT NULL DEFAULT 'active', -- active | awaiting_confirmation | submitted | incomplete | expired
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS whatsapp_onboarding_sessions_wa_phone_idx
  ON whatsapp_onboarding_sessions (wa_phone);
CREATE INDEX IF NOT EXISTS whatsapp_onboarding_sessions_status_inbound_idx
  ON whatsapp_onboarding_sessions (session_status, last_inbound_at);
CREATE INDEX IF NOT EXISTS whatsapp_onboarding_sessions_application_id_idx
  ON whatsapp_onboarding_sessions (application_id);

-- ── 2. Message log (audit + idempotency + delivery) ─────────────────────────
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            uuid REFERENCES whatsapp_onboarding_sessions(id),
  provider_message_id   text,                            -- dedupe key (see UNIQUE index below)
  direction             varchar(12) NOT NULL,            -- inbound | outbound
  message_type          varchar(24) NOT NULL,            -- text | image | document | audio | template | interactive
  text_body             text,                            -- message text / caption
  media_provider_id     text,                            -- provider media handle (before download)
  storage_path          text,                            -- bucket path once SAVEd
  template_name         text,                            -- outbound template used (out-of-24h sends)
  delivery_status       varchar(16),                     -- sent | delivered | read | failed
  raw_payload           jsonb,                           -- full provider event, for debugging
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- provider_message_id is the idempotency key: a duplicate inbound webhook
-- delivery is a no-op (the orchestrator's INSERT ... ON CONFLICT DO NOTHING
-- relies on this). A plain (non-partial) unique index is used deliberately so
-- ON CONFLICT (provider_message_id) can infer it; our own outbound rows insert
-- provider_message_id = NULL, and Postgres treats NULLs as distinct in a unique
-- index, so multiple NULL outbound rows never collide.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_messages_provider_message_id_unique
  ON whatsapp_messages (provider_message_id);
CREATE INDEX IF NOT EXISTS whatsapp_messages_session_id_idx
  ON whatsapp_messages (session_id);

-- ── 3. Onboarding application — WhatsApp linkage + admin-visible metadata ────
ALTER TABLE dealer_onboarding_applications
  ADD COLUMN IF NOT EXISTS source                 varchar(16) NOT NULL DEFAULT 'web', -- web | whatsapp
  ADD COLUMN IF NOT EXISTS wa_phone               varchar(20),
  ADD COLUMN IF NOT EXISTS wa_session_id          uuid,
  ADD COLUMN IF NOT EXISTS verification_warnings  jsonb NOT NULL DEFAULT '[]'::jsonb, -- failed/mismatched checks surfaced to admin
  ADD COLUMN IF NOT EXISTS extraction_summary     jsonb NOT NULL DEFAULT '{}'::jsonb, -- per-field value + source doc + confidence
  ADD COLUMN IF NOT EXISTS dealer_confirmed_at    timestamptz;                        -- set on WhatsApp CONFIRM (gate to submit)

CREATE INDEX IF NOT EXISTS dealer_onboarding_applications_source_idx
  ON dealer_onboarding_applications (source);

-- ── 4. Onboarding document — per-doc extraction/verification provenance ──────
-- extracted_data + api_verification_results jsonb already exist; reuse them.
ALTER TABLE dealer_onboarding_documents
  ADD COLUMN IF NOT EXISTS source                 varchar(16) NOT NULL DEFAULT 'web', -- web | whatsapp
  ADD COLUMN IF NOT EXISTS extraction_engine      varchar(24),                        -- gemini | documentai | textract | manual
  ADD COLUMN IF NOT EXISTS extraction_confidence  numeric,                            -- 0..1, drives fallback policy
  ADD COLUMN IF NOT EXISTS verification_provider  varchar(24);                        -- decentro | none

COMMENT ON TABLE whatsapp_onboarding_sessions IS
  'E-167 — one row per dealer WhatsApp onboarding conversation; persists the state machine so a dropped chat resumes where it left off.';
COMMENT ON TABLE whatsapp_messages IS
  'E-167 — append-only WhatsApp message log: audit trail, idempotency (provider_message_id UNIQUE), and delivery-status tracking.';
