-- E-297 — Quotation CC (2026-09-17).
--
-- When an approved quotation is emailed to the dealer, the email is CC'd to
-- (a) the lead's current owner, (b) the quote approver and (c) an
-- admin-configured fixed list of internal addresses. See
-- src/lib/leads/quotationCc.ts.
--
-- Additive + idempotent. Re-running this file is a no-op.
--
-- (1) quotation_dispatches.cc_recipients — the CC list actually used on that
--     send, snapshotted like `recipient`. NULL on WhatsApp rows and on every
--     pre-E-297 row. The dispatch logger falls back to an INSERT without this
--     column when it is missing, so code deployed ahead of this migration still
--     records sends.
--
-- (2) The fixed list needs NO table: it is one jsonb blob under the
--     `quotation_cc_emails` key in the existing generic `app_settings` store
--     ({ "emails": [...], "updated_by": "<uuid>" }). The CREATE below is only a
--     guard for a DB that predates app_settings; it does nothing where the table
--     already exists.

DO $do$
BEGIN
  ALTER TABLE quotation_dispatches
    ADD COLUMN IF NOT EXISTS cc_recipients jsonb;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'E-297: quotation_dispatches does not exist (E-242 not applied) — skip';
END;
$do$;

CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY NOT NULL,
  value      jsonb NOT NULL,
  updated_at timestamptz DEFAULT now()
);
