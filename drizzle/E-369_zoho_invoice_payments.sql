-- =============================================================================
-- E-369 — PAYMENTS ENTERED ON OLD ZOHO INVOICES (ID 200 f)
-- =============================================================================
-- WHY.
--   Decided 2 Nov (Kartik): Vyapar is the only source of payments for Drive /
--   Vyapar invoices (the weekly Sale Report upload), and the CEO's Payment
--   button stays ONLY for old Zoho invoices, so Finance can clear the Zoho-era
--   invoices still counted in Accounts Receivable. A Zoho invoice's own
--   `balance` is rewritten by the Zoho sync, so a payment entered in the CRM
--   cannot live on zoho_invoices: it is kept here and taken off the balance.
--
-- WHAT. zoho_invoice_payments — one row per Zoho invoice (zoho_invoices.id):
--   the total collected so far as entered in the CRM (absolute, not an
--   increment), the reference, who and when. Receivables read
--   balance = GREATEST(zoho balance - amount_paid, 0).
--
-- NOT mirrored in schema.ts — raw SQL behind a to_regclass probe
-- (src/lib/sales/ledgerTables.ts `hasZohoInvoicePayments`), so the code is
-- safe in either order: without this table the Zoho balance counts as before
-- and the Payment button says the database change is pending.
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS zoho_invoice_payments (
    invoice_id         uuid PRIMARY KEY,
    amount_paid        numeric(14, 2) NOT NULL DEFAULT 0,
    payment_reference  varchar(255),
    last_payment_date  date,
    recorded_by        varchar(64),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

DO $do$
BEGIN
    ALTER TABLE zoho_invoice_payments
        ADD CONSTRAINT zoho_invoice_payments_amount_check CHECK (amount_paid >= 0);
EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE 'zoho_invoice_payments_amount_check exists, skip';
END;
$do$;

DO $do$
BEGIN
    ALTER TABLE zoho_invoice_payments
        ADD CONSTRAINT zoho_invoice_payments_invoice_fk
        FOREIGN KEY (invoice_id) REFERENCES zoho_invoices (id) ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN RAISE NOTICE 'zoho_invoice_payments_invoice_fk exists, skip';
    WHEN undefined_table THEN RAISE NOTICE 'zoho_invoices missing, FK skipped';
END;
$do$;
