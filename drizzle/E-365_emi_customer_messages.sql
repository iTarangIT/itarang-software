-- =============================================================================
-- E-365 — EMI MESSAGES TO THE CUSTOMER (tracker ID 204, Kartik 28 Oct)
-- =============================================================================
-- WHY.
--   Nothing told a financed customer their EMI was due or that a payment had
--   been received, and the lender portal's "Send payment reminder" only
--   wrote a row. The daily overdue job ran only as a Vercel cron, which never
--   fires on the PM2 boxes.
--
-- WHAT. emi_customer_messages — one row per message per channel:
--   kind      due_3d | due_today | overdue_1 | overdue_3 | overdue_7 | received | reminder
--   channel   whatsapp | sms
--   status    sending | sent | delivered | read | failed | skipped
--   The UNIQUE key (emi_schedule_id, kind, channel, ref) is the claim that
--   makes each message go once per EMI (ref = '' for the scheduled ones, the
--   payment reference for "received", the action id for a portal reminder).
--   provider_message_id joins the WhatsApp / MSG91 delivery reports.
--
-- The settings (on/off, days, Hindi texts, template names, DLT ids, pilot
-- lender) live in app_settings['emi_messages'] — no DDL. Ships OFF.
--
-- NOT mirrored in schema.ts — raw SQL behind a to_regclass probe
-- (src/lib/emi-messages/store.ts), so the code is safe before this file is
-- applied: without it no EMI message is sent. Strictly additive, idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS emi_customer_messages (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    emi_schedule_id     uuid,
    loan_sanction_id    varchar(255) NOT NULL,
    lead_id             varchar(255),
    nbfc_id             uuid,
    kind                varchar(16) NOT NULL,
    channel             varchar(10) NOT NULL,
    ref                 varchar(100) NOT NULL DEFAULT '',
    phone               varchar(20),
    body                text,
    provider_message_id varchar(200),
    status              varchar(12) NOT NULL DEFAULT 'sending',
    error               text,
    is_test             boolean NOT NULL DEFAULT false,
    created_at          timestamptz NOT NULL DEFAULT now(),
    sent_at             timestamptz,
    delivered_at        timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS emi_customer_messages_once_key
    ON emi_customer_messages (emi_schedule_id, kind, channel, ref)
    WHERE emi_schedule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS emi_customer_messages_provider_idx
    ON emi_customer_messages (provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS emi_customer_messages_lender_day_idx
    ON emi_customer_messages (nbfc_id, created_at);
CREATE INDEX IF NOT EXISTS emi_customer_messages_loan_idx
    ON emi_customer_messages (loan_sanction_id, created_at);

DO $do$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'emi_customer_messages_kind_chk') THEN
        ALTER TABLE emi_customer_messages ADD CONSTRAINT emi_customer_messages_kind_chk
            CHECK (kind IN ('due_3d', 'due_today', 'overdue_1', 'overdue_3', 'overdue_7', 'received', 'reminder'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'emi_customer_messages_channel_chk') THEN
        ALTER TABLE emi_customer_messages ADD CONSTRAINT emi_customer_messages_channel_chk
            CHECK (channel IN ('whatsapp', 'sms'));
    END IF;
END;
$do$;

COMMENT ON TABLE emi_customer_messages IS
  'E-365 / ID 204 — EMI follow-up and "EMI received" messages to a financed customer (WhatsApp + SMS), one row per message per channel.';
