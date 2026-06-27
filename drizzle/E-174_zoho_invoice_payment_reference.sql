-- E-174 — Track real payment transaction references on paid Zoho invoices.
--
-- The hourly invoice sync (lib/zoho/sync.ts) only pulls the /invoices list,
-- which carries no payment/UTR reference — those live in Zoho's separate
-- /customerpayments resource. To let the CEO see the bank transaction id behind
-- a paid invoice, the sync now also pulls customer payments and stamps the
-- latest payment's reference onto the matching zoho_invoices row.
--
--   payment_reference  — the payment's reference_number (UTR / bank txn id)
--   payment_id         — Zoho payment_id of the latest applied payment
--   last_payment_date  — date of that latest payment (used to pick "latest")
--
-- Additive only; safe to re-run.

ALTER TABLE "zoho_invoices"
    ADD COLUMN IF NOT EXISTS "payment_reference" text;

ALTER TABLE "zoho_invoices"
    ADD COLUMN IF NOT EXISTS "payment_id" varchar(64);

ALTER TABLE "zoho_invoices"
    ADD COLUMN IF NOT EXISTS "last_payment_date" date;
