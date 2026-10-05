-- E-326 — sales invoice line items, for gross margin (tracker ID 72, handover
-- P1-10; the line half of ID 39).
--
-- Until now a Drive sales invoice was stored as its header only (customer,
-- GSTINs, sub-total, tax, total). Gross margin needs what was sold:
--
--   gross margin = line value before GST − quantity × average OEM cost of
--                  that product (inventory.inventory_amount; OEM price book as
--                  the fallback)
--
--   sales_invoice_lines
--       One row per line of a sales invoice: description, HSN, quantity, rate
--       and the taxable amount (before GST). `source` says who read it —
--       'drive' (read off the PDF) today; 'vyapar' / 'zoho' are reserved for
--       the structured imports (IDs 39 / 70), which will replace a 'drive'
--       reading of the same invoice.
--
--   sales_invoice_item_products
--       The one-time mapping from an invoice item name to a CRM product.
--       Keyed on the normalised item name, so mapping an item once covers
--       every invoice that carries it — past and future. `product_id` NULL =
--       seen, not mapped yet. `auto_matched` = the system proposed it from the
--       voltage / Ah in the name; a person has not confirmed it.
--
-- DDL: additive + idempotent. Mirrored in schema.ts. Re-run = no-op.

CREATE TABLE IF NOT EXISTS sales_invoice_lines (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source           varchar(16) NOT NULL DEFAULT 'drive',
    sales_invoice_id uuid NOT NULL,
    line_no          integer NOT NULL,
    description      text,
    item_key         text,
    hsn_code         varchar(16),
    quantity         numeric(12, 3),
    rate             numeric(14, 2),
    amount           numeric(14, 2),
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sales_invoice_lines_invoice_line_unique
    ON sales_invoice_lines (sales_invoice_id, line_no);

CREATE INDEX IF NOT EXISTS sales_invoice_lines_item_key_idx
    ON sales_invoice_lines (item_key);

CREATE TABLE IF NOT EXISTS sales_invoice_item_products (
    item_key     text PRIMARY KEY,
    item_name    text NOT NULL,
    product_id   uuid,
    auto_matched boolean NOT NULL DEFAULT false,
    mapped_by    uuid,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
