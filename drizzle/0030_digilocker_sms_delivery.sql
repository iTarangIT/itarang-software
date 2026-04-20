ALTER TABLE "digilocker_transactions"
    ADD COLUMN IF NOT EXISTS "sms_message_id" varchar(255),
    ADD COLUMN IF NOT EXISTS "sms_delivered_at" timestamp with time zone,
    ADD COLUMN IF NOT EXISTS "sms_failed_reason" text,
    ADD COLUMN IF NOT EXISTS "sms_attempts" integer DEFAULT 0 NOT NULL;
