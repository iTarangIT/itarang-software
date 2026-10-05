-- E-322: Quote terms, invoice lines, Zoho GSTIN backfill, Vyapar import,
-- invoice voids, credit notes, GSTR-1 reconciliation.
-- Tracker P1 IDs 39, 70, 71, 73 (handover P1-7, P1-8, P1-9, P1-13), 2026-10-03.
-- Requires E-280 (sales_invoices, sales_invoice_folders).
--
-- 1. dealer_lead_commercials + dealer_payment_terms / credit_days /
--    customer_finance (ID 73). Nullable; old quotes untouched. REQUIRED once
--    deployed — Drizzle names these in every commercials INSERT.
-- 2. invoice_line_items (IDs 39, 70) — NOT invoice_lines, which is the buyback
--    vendor-invoice table (E-187) — line items for any invoice source: 'zoho'
--    (one-time backfill), 'drive' / 'vyapar' (weekly Vyapar register import).
--    Classified by HSN: 8507 battery, 850440 charger, else other.
-- 3. zoho_customer_gstins (ID 70) — each Zoho customer's GSTIN, fetched once.
--    A separate table because the hourly Zoho upsert rewrites zoho_invoices'
--    own columns (raw_json included) every run.
-- 4. vyapar_item_map (ID 39) — Vyapar item name → CRM product.
-- 5. invoice_imports (IDs 39, 71) — one row per uploaded register / GSTR-1 file.
-- 6. invoice_voids (ID 71) — finance's void (reason, who, when) or a Vyapar
--    cancellation, for either invoice table. Revenue treats a voided invoice as
--    status 'void'. Separate table for the same reason as (3).
-- 7. credit_notes (ID 71) — read from their own Drive folder; subtracted in
--    the month they are issued.
-- 8. sales_invoice_folders + doc_kind ('sale' | 'credit_note').
-- 9. gstr1_entries (ID 71) — filed GSTR-1 rows, for the monthly reconciliation.
--
-- Additive and idempotent — safe to re-run.

-- ── 1. Quote terms ───────────────────────────────────────────────────────────
ALTER TABLE dealer_lead_commercials ADD COLUMN IF NOT EXISTS dealer_payment_terms varchar(10);
ALTER TABLE dealer_lead_commercials ADD COLUMN IF NOT EXISTS credit_days integer;
ALTER TABLE dealer_lead_commercials ADD COLUMN IF NOT EXISTS customer_finance boolean;

-- ── 2. invoice_line_items ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_line_items (
    source          varchar(10) NOT NULL,        -- 'zoho' | 'drive' | 'vyapar'
    invoice_id      text NOT NULL,               -- zoho_invoices.id / sales_invoices.id
    line_no         integer NOT NULL,
    item_name       text,
    hsn             varchar(12),
    product_class   varchar(10) NOT NULL,        -- 'battery' | 'charger' | 'other'
    asset_type      varchar(30),
    product_id      text,
    quantity        numeric(14, 3),
    rate            numeric(14, 2),
    amount_excl_gst numeric(14, 2),
    import_id       uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source, invoice_id, line_no)
);
CREATE INDEX IF NOT EXISTS invoice_line_items_class_idx ON invoice_line_items (product_class);
CREATE INDEX IF NOT EXISTS invoice_line_items_product_idx ON invoice_line_items (product_id);

-- ── 3. zoho_customer_gstins ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS zoho_customer_gstins (
    organization_id text NOT NULL,
    customer_id     text NOT NULL,
    gstin           varchar(15),                 -- NULL = fetched, customer has none
    fetched_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, customer_id)
);

-- ── 4. vyapar_item_map ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vyapar_item_map (
    item_key   text PRIMARY KEY,                 -- lower-cased, single-spaced name
    item_name  text NOT NULL,
    asset_type varchar(30),
    product_id text,
    mapped_by  uuid,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── 5. invoice_imports ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_imports (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind          varchar(20) NOT NULL,          -- 'vyapar_register' | 'gstr1'
    file_name     text,
    storage_key   text,
    period_from   date,
    period_to     date,
    summary       jsonb,
    imported_by   uuid,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── 6. invoice_voids ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_voids (
    source     varchar(10) NOT NULL,             -- 'zoho' | 'drive' | 'vyapar'
    invoice_id text NOT NULL,
    reason     text NOT NULL,
    origin     varchar(10) NOT NULL,             -- 'manual' | 'vyapar'
    voided_by  uuid,
    voided_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source, invoice_id)
);

-- ── 7. credit_notes ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_notes (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    note_number            text,
    note_number_key        text,
    issue_date             date,
    customer_name          text,
    customer_gstin         varchar(20),
    organization_id        text,
    seller_gstin           varchar(20),
    against_invoice_number text,
    sub_total              numeric(14, 2),
    tax_total              numeric(14, 2),
    total                  numeric(14, 2),
    drive_file_id          text,
    file_name              text,
    document_url           text,
    ai_raw                 jsonb,
    needs_attention        boolean NOT NULL DEFAULT false,
    attention_reason       text,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS credit_notes_number_key_uniq
    ON credit_notes (note_number_key) WHERE note_number_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS credit_notes_drive_file_uniq
    ON credit_notes (drive_file_id) WHERE drive_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS credit_notes_issue_date_idx ON credit_notes (issue_date);

-- ── 8. sales_invoice_folders.doc_kind ────────────────────────────────────────
DO $do$ BEGIN
    ALTER TABLE sales_invoice_folders ADD COLUMN IF NOT EXISTS doc_kind varchar(20) NOT NULL DEFAULT 'sale';
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'skip: sales_invoice_folders absent (E-280 not applied)';
END; $do$;

-- ── 9. gstr1_entries ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gstr1_entries (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    import_id          uuid NOT NULL,
    month              date NOT NULL,            -- first day of the return period
    doc_type           varchar(12) NOT NULL,     -- 'invoice' | 'credit_note'
    doc_number         text NOT NULL,
    doc_number_key     text NOT NULL,
    doc_date           date,
    gstin              varchar(20),
    taxable_value      numeric(14, 2),
    tax                numeric(14, 2),
    total              numeric(14, 2),
    created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gstr1_entries_month_idx ON gstr1_entries (month, doc_number_key);
