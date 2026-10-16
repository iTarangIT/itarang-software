-- =============================================================================
-- E-348 — "STOCK TO UPLOAD" TASKS FROM EACH NEW BATTERY INVOICE (tracker ID 174)
-- =============================================================================
-- WHY. Kartik decided on 10 Oct: each new sales invoice read creates a "Stock
-- to upload" task for the Inventory Manager / Admin / partner (Chirag). The
-- check is by serial and buyer only: every battery serial printed on the
-- invoice must be in the stock of the dealer on the invoice (Bill To GSTIN).
-- The task closes by itself when all of them are; still open after 2 working
-- days (office calendar) it escalates to Admin and the CEO.
--
-- WHAT. Two new tables on the main CRM database:
--   invoice_line_serials — the serial numbers the invoice reader returned per
--     battery line (src/lib/sales/saveInvoiceLines.ts, Gemini line reader).
--   stock_upload_tasks   — one task per invoice: buyer account, expected
--     serial count (battery quantity), status open / escalated / closed,
--     due_at (2 working days), closed_at / escalated_at.
-- Written by src/lib/inventory/stockUploadTasks/service.ts; checked on every
-- stock upload and by the hourly stock-upload sweep (instrumentation-node.ts).
--
-- The code never requires these tables: every reader and writer probes with
-- to_regclass first, so a database without E-348 reads "no tasks" and the
-- invoice scan goes on as before.
--
-- Additive + idempotent. Re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS invoice_line_serials (
    id              bigserial PRIMARY KEY,
    -- 'drive' (sales_invoices) today; present so another source is distinguishable.
    invoice_source  varchar(10)  NOT NULL DEFAULT 'drive',
    invoice_id      text         NOT NULL,
    line_no         integer      NOT NULL,
    serial_number   varchar(100) NOT NULL,
    created_at      timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS invoice_line_serials_uniq
    ON invoice_line_serials (invoice_source, invoice_id, serial_number);
CREATE INDEX IF NOT EXISTS invoice_line_serials_serial_idx
    ON invoice_line_serials (serial_number);

CREATE TABLE IF NOT EXISTS stock_upload_tasks (
    id                bigserial PRIMARY KEY,
    invoice_source    varchar(10)  NOT NULL DEFAULT 'drive',
    invoice_id        text         NOT NULL,
    invoice_number    text,
    invoice_date      date,
    customer_name     text,
    customer_gstin    varchar(20),
    -- The buyer dealer: accounts.id (= users.dealer_id). NULL when the Bill To
    -- GSTIN matches no dealer account — the task then cannot close by itself.
    account_id        varchar(255),
    -- Sum of the battery lines' quantity; the serials read may be fewer.
    expected_serials  integer      NOT NULL DEFAULT 0,
    read_serials      integer      NOT NULL DEFAULT 0,
    in_stock_serials  integer      NOT NULL DEFAULT 0,
    -- 'open' | 'escalated' | 'closed'
    status            varchar(12)  NOT NULL DEFAULT 'open',
    due_at            timestamptz,
    created_at        timestamptz  NOT NULL DEFAULT now(),
    last_checked_at   timestamptz,
    escalated_at      timestamptz,
    closed_at         timestamptz,
    -- 'auto' (all serials in the buyer's stock) | 'by_hand'
    closed_how        varchar(10),
    closed_by         uuid,
    close_note        text
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_upload_tasks_invoice_uniq
    ON stock_upload_tasks (invoice_source, invoice_id);
CREATE INDEX IF NOT EXISTS stock_upload_tasks_status_idx
    ON stock_upload_tasks (status, due_at);
CREATE INDEX IF NOT EXISTS stock_upload_tasks_account_idx
    ON stock_upload_tasks (account_id);
