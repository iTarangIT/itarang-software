-- E-176 — Manual / offline dealer-sales uploads (CEO dashboard).
--
-- Additive + idempotent. The "Sales to Dealer" tile on the CEO dashboard is fed
-- by Zoho-synced invoices (zoho_invoices). Some dealer sales happen offline and
-- never reach Zoho; this table lets the CEO bulk-upload those rows (Excel/CSV)
-- so they show up alongside the Zoho rows in the Sales-to-Dealer drill-down and
-- count toward the MTD total. Mirror every change in src/lib/db/schema.ts.

CREATE TABLE IF NOT EXISTS manual_dealer_sales (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_date       date NOT NULL,                 -- the sale / invoice date
  customer_name   text,                          -- dealer / customer name
  product_name    text,                          -- product sold
  quantity        numeric(12, 2),                -- units (decimal-friendly)
  amount          numeric(14, 2) NOT NULL DEFAULT 0, -- sale value in INR
  invoice_number  text,                          -- optional offline invoice ref
  uploaded_by     text,                          -- users.id of the uploader
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS manual_dealer_sales_sale_date_idx
  ON manual_dealer_sales (sale_date);
