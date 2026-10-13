-- =============================================================================
-- E-340 — ZOHO COPY: FETCH MARKERS + REFUSED GSTINS (tracker IDs 70, 62, 2026-10-13)
-- =============================================================================
-- Requires E-322 (invoice_line_items, zoho_customer_gstins).
--
-- 1. zoho_invoice_line_fetches (ID 70) — one row per Zoho invoice whose detail
--    the one-time copy (scripts/backfill-zoho-gstin-lines.ts) has read. Before
--    this, "done" meant "has lines", so an invoice Zoho holds with no lines was
--    fetched again on every run. Keyed by zoho_invoices.id::text, the same key
--    invoice_line_items.invoice_id uses.
--
-- 2. zoho_customer_gstins.refused_gstin / refused_reason (ID 62) — a GSTIN Zoho
--    printed for the customer that FAILED the check (bad check character, or
--    iTarang's own). gstin stays NULL, so it never matches a dealer; the refused
--    value is kept so Invoice Ledger › Needs attention can list those Zoho
--    invoices ("Customer GSTIN fails check" / "Customer GSTIN is ours") instead
--    of only the copy run's console output.
--
-- NOT mirrored in src/lib/db/schema.ts: the copy script and the Needs attention
-- reader use raw SQL behind to_regclass / information_schema probes, so code on
-- a database without this file behaves as before. Strictly additive, idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS zoho_invoice_line_fetches (
    invoice_id  text PRIMARY KEY,
    line_count  integer NOT NULL DEFAULT 0,
    fetched_at  timestamptz NOT NULL DEFAULT now()
);

DO $do$
BEGIN
    ALTER TABLE zoho_customer_gstins ADD COLUMN IF NOT EXISTS refused_gstin text;
    ALTER TABLE zoho_customer_gstins ADD COLUMN IF NOT EXISTS refused_reason text;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'zoho_customer_gstins missing (E-322 not applied) — skipped';
END;
$do$;

-- Invoices copied before this file count as fetched (they have lines).
INSERT INTO zoho_invoice_line_fetches (invoice_id, line_count)
SELECT l.invoice_id, COUNT(*)::int
  FROM invoice_line_items l
 WHERE l.source = 'zoho'
 GROUP BY l.invoice_id
ON CONFLICT (invoice_id) DO NOTHING;
