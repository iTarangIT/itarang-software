-- =============================================================================
-- E-368 — VYAPAR PAYMENT SYNC: HOW MUCH OF EACH CREDIT NOTE IS ALREADY USED
-- =============================================================================
-- WHY.
--   Accounts Receivable nets every non-void credit note against what the
--   customer owes, at its FULL total. In Vyapar, when Finance adjusts a credit
--   note against an invoice, the invoice's "Received/Paid Amount" goes up by
--   that amount AND the note's "Balance Due" drops to 0. The weekly Sale
--   Report upload (ID 200) already carries the invoice's new Received figure
--   into sales_invoices.amount_paid — so subtracting the note's full total as
--   well counts the same money twice and understates the receivable.
--
-- WHAT. credit_note_applications — one row per credit note: the part of it
--   already used (total less Vyapar's Balance Due on the latest register
--   upload), when that was true (the export's "Generated on" stamp), and the
--   import that set it. Receivables then net only the unused part:
--   balance = -(total - amount_applied), never below -total, never above 0.
--
-- NOT mirrored in schema.ts — raw SQL behind a to_regclass probe
-- (src/lib/sales/ledgerTables.ts `hasCreditNoteApplications`), so the code is
-- safe in either order: without this table a credit note nets at its full
-- total, exactly as before.
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS credit_note_applications (
    credit_note_id  uuid PRIMARY KEY,
    amount_applied  numeric(14, 2) NOT NULL DEFAULT 0,
    source          varchar(16) NOT NULL DEFAULT 'vyapar',
    as_of           timestamptz,
    import_id       uuid,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

DO $do$
BEGIN
    ALTER TABLE credit_note_applications
        ADD CONSTRAINT credit_note_applications_amount_check CHECK (amount_applied >= 0);
EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE 'credit_note_applications_amount_check exists, skip';
END;
$do$;

DO $do$
BEGIN
    ALTER TABLE credit_note_applications
        ADD CONSTRAINT credit_note_applications_note_fk
        FOREIGN KEY (credit_note_id) REFERENCES credit_notes(id) ON DELETE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN RAISE NOTICE 'credit_note_applications_note_fk exists, skip';
    WHEN undefined_table THEN RAISE NOTICE 'credit_notes missing (E-322 not applied), FK skipped';
END;
$do$;
