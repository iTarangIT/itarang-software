-- E-127_onboarding_application_part0_columns.sql
--
-- BRD §0.13 Point A — Conversion → Onboarding integration. When an Inside
-- Sales rep / ASM marks a dealer lead Converted, the system creates a
-- dealer_onboarding_applications row pre-populated from the lead + its
-- commercials. This migration adds the columns that mapping needs.
--
-- originating_dealer_lead_id carries a partial UNIQUE index so a duplicate
-- Mark Converted (e.g. a Lost → Reactivated → Converted-again lead) is
-- blocked at the DB level — the conversion reuses the existing row.
--
-- Strictly additive + idempotent: every statement is ADD COLUMN IF NOT EXISTS
-- / CREATE INDEX IF NOT EXISTS. No DROP, no type narrowing. Re-running is a
-- no-op. Apply via pgAdmin Query Tool against AWS Postgres.

ALTER TABLE dealer_onboarding_applications
    ADD COLUMN IF NOT EXISTS originating_dealer_lead_id text,
    ADD COLUMN IF NOT EXISTS sponsoring_asm_id          text,
    ADD COLUMN IF NOT EXISTS owner_id                   text,
    ADD COLUMN IF NOT EXISTS field_verification_status  jsonb DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS source_ai_session_id       text,
    ADD COLUMN IF NOT EXISTS source_ai_intent_score     integer,
    ADD COLUMN IF NOT EXISTS source_ai_recording_url    text,
    ADD COLUMN IF NOT EXISTS payment_intent_note        text,
    ADD COLUMN IF NOT EXISTS communication_language     varchar(40),
    ADD COLUMN IF NOT EXISTS business_segments          jsonb DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS proposed_deal_value        numeric(14,2),
    ADD COLUMN IF NOT EXISTS proposed_credit_terms      text,
    ADD COLUMN IF NOT EXISTS proposed_delivery_terms    text,
    ADD COLUMN IF NOT EXISTS proposed_warranty_terms    text,
    ADD COLUMN IF NOT EXISTS proposed_terms_notes       text,
    ADD COLUMN IF NOT EXISTS payment_method             varchar(20),
    ADD COLUMN IF NOT EXISTS deal_notes                 text,
    ADD COLUMN IF NOT EXISTS quote_document_url         text;

-- Idempotency guard for Mark Converted (BRD §0.13 Point A).
CREATE UNIQUE INDEX IF NOT EXISTS dealer_onboarding_applications_originating_lead_uniq
    ON dealer_onboarding_applications (originating_dealer_lead_id)
    WHERE originating_dealer_lead_id IS NOT NULL;

-- Verification:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'dealer_onboarding_applications'
--      AND column_name LIKE 'proposed_%';
--   -- expect 5 rows
