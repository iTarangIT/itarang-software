-- =============================================================================
-- E-371 — EMI SMS PLAN: day-wise DLT templates (business, 4 Nov)
-- =============================================================================
-- WHY.
--   SMS now go on 31 day-wise reminder templates (the due day written into
--   the text), a "due today" template, one overdue template with the total
--   unpaid and the "received" template. Admin / Sales Head set the days
--   (e.g. 7, 5, 1 before; overdue daily or every N days) and switch the
--   messages on per financer. Settings stay in app_settings['emi_messages'].
--
-- WHAT. emi_customer_messages.kind takes three more values:
--   sms_before     a reminder N days before (ref = 'b<N>')
--   sms_due_today  the due-day "आज देय है" SMS (ref = '')
--   sms_overdue    the total-overdue SMS (ref = 'o<days overdue>')
--   The claim key (emi_schedule_id, kind, channel, ref) keeps each step once
--   per EMI. The check is only WIDENED (old values stay valid).
--
-- Without this file the SMS plan does not run (probe: store.ts
-- hasEmiSmsKinds); WhatsApp messages are unaffected. Idempotent.
-- =============================================================================

DO $do$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'emi_customer_messages_kind_chk'
           AND pg_get_constraintdef(oid) LIKE '%sms_before%'
    ) THEN
        ALTER TABLE emi_customer_messages DROP CONSTRAINT IF EXISTS emi_customer_messages_kind_chk;
        ALTER TABLE emi_customer_messages ADD CONSTRAINT emi_customer_messages_kind_chk
            CHECK (kind IN ('due_3d', 'due_today', 'overdue_1', 'overdue_3', 'overdue_7', 'received', 'reminder',
                            'sms_before', 'sms_due_today', 'sms_overdue'));
    END IF;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: emi_customer_messages does not exist yet — apply E-365 first';
END;
$do$;
