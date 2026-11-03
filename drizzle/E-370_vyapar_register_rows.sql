-- =============================================================================
-- E-370 — VYAPAR IMPORT: WHAT WAS LAST IMPORTED, PER INVOICE
-- =============================================================================
-- WHY.
--   Finance uploads Vyapar's Sale Report every week with overlapping dates, so
--   most rows are invoices the CRM already has. Business rules (3 Nov):
--     * Duplicate — same invoice number, date and amount as what was last
--       imported → not imported again (no rewrite of its lines or payment).
--     * Updated — same number but the amount, received or balance due (or the
--       date, items or cancelled flag) changed → the existing invoice is
--       updated, never a second one created.
--     * Payment validation — each row is compared with the LAST IMPORTED data:
--       changed → update, unchanged → skip.
--
-- WHAT. vyapar_register_rows — one row per document number (invoice or credit
--   note), as it stood in the newest Sale Report imported: date, total,
--   received, balance, status, cancelled, a hash of its item lines, and the
--   import / export it came from. The import upserts it for every document it
--   reads, skipped duplicates included.
--
-- NOT mirrored in schema.ts — raw SQL behind a to_regclass probe
-- (src/lib/sales/ledgerTables.ts `hasVyaparRegisterRows`), so the code is safe
-- in either order: without this table the first import compares with the CRM
-- invoice itself (total, amount paid, date) and nothing is remembered.
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS vyapar_register_rows (
    number_key      text PRIMARY KEY,
    doc_type        varchar(16) NOT NULL DEFAULT 'invoice',
    invoice_number  text NOT NULL,
    invoice_date    date,
    total           numeric(14, 2),
    received        numeric(14, 2),
    balance         numeric(14, 2),
    status_text     text,
    cancelled       boolean NOT NULL DEFAULT false,
    lines_hash      varchar(16),
    import_id       uuid,
    generated_at    timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

DO $do$
BEGIN
    ALTER TABLE vyapar_register_rows
        ADD CONSTRAINT vyapar_register_rows_doc_type_check CHECK (doc_type IN ('invoice', 'credit_note'));
EXCEPTION WHEN duplicate_object THEN
    RAISE NOTICE 'vyapar_register_rows_doc_type_check exists, skip';
END;
$do$;

CREATE INDEX IF NOT EXISTS vyapar_register_rows_import_idx ON vyapar_register_rows (import_id);
