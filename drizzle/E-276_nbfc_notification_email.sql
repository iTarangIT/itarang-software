-- E-276 — NBFC event notification email (2026-08-31).
--
-- One nullable recipient column on nbfc_notification_channels: the address the
-- NBFC wants event emails delivered To (files arriving in its dashboard,
-- reject / correction-request confirmations, offer accepted, loan disbursed).
-- The platform-wide monitoring address is CC'd from the
-- NBFC_GLOBAL_NOTIFY_EMAIL env var and is not stored in the DB.
-- Fallback chain when NULL: nbfc_tenants.contact_email →
-- nbfc.primary_contact_email (see src/lib/nbfc/event-mailer.ts).
--
-- REQUIRED before the code deploys: nbfc_notification_channels is mirrored in
-- schema.ts, so the settings GET/PUT names this column.
-- Re-running this file is a no-op.

ALTER TABLE "nbfc_notification_channels"
  ADD COLUMN IF NOT EXISTS "notification_email" text;
