------------------------------------------------------------------------------
-- E-196: the Proforma Invoice — the document that answers the vendor's PO.
--
-- Items 8 + 15, which are one job. The requested flow:
--   1. vendor accepts the quotation
--   2. the VENDOR (the buyer on this leg) raises a PO to iTarang
--   3. iTarang (the seller to the vendor) raises a PROFORMA INVOICE against it
--   4. the vendor pays against the PI
--
-- Steps 1 and 2 already work, and the PO direction was already correct: leg=
-- VENDOR is stored direction='RECEIVED' because the buyer initiates, which is
-- why direction is stored and not derived. What was missing is step 3 — and the
-- reason the sequence read as "jumbled" is that NOTHING ANSWERS THE VENDOR'S PO.
-- It lands, and the vendor hears nothing until a payment link appears.
--
-- "AGAINST" IS LOAD-BEARING AND WAS UNMODELLED. `invoices` has no po_id; the
-- existing vendor invoice reaches its PO only through an ad-hoc correlated
-- subquery, for display. A proforma that does not name the PO it answers is not
-- answering anything. Hence proforma_invoices.po_id, NOT NULL.
--
-- WHY A NEW TABLE, not an `invoices` row and not a `kind` column:
--   · `invoices` is the TAX slot. INV-{n}-V is raised at approve_invoice and
--     draws on buyback_invoice_no_seq — a statutory series. A proforma is not a
--     tax document and must not consume a tax number. Today's vendor document
--     does exactly that: it is a proforma in substance (its own template says it
--     is not a tax invoice) wearing an invoice's number. That is the bug.
--   · invoices_one_live_per_deal_leg (E-187) already means ONE live invoice per
--     (deal, leg). A PI sharing that table would either fight that index or
--     force it open — and it is the index that stops a deal being invoiced twice.
--   · They have different lifecycles. An invoice is RAISED → APPROVED/RETURNED,
--     matched line-by-line against the locks. A proforma is ISSUED → SUPERSEDED
--     when re-issued. Nothing matches a proforma; it is our own statement of what
--     we will charge.
--
-- NO TAX COLUMNS HERE, DELIBERATELY. purchase_order_lines and invoice_lines
-- carry hsn_code/taxable_value/cgst/sgst/igst/reverse_charge — modelled and, to
-- this day, never populated by a single line of buyback code. A proforma is
-- explicitly tax-exclusive, so it gets NOWHERE to put tax: the document cannot
-- imply a treatment nobody has agreed. When Chirag rules, the tax invoice is
-- where that lands — the slot is already there and already empty.
--
-- Additive + idempotent. The whole file no-ops with a NOTICE where the buyback
-- tables do not exist (production).
------------------------------------------------------------------------------

DO $do$ BEGIN
  IF to_regclass('public.buyback_deals') IS NULL THEN
    RAISE NOTICE 'E-196: no buyback tables here (production) — skipping.';
    RETURN;
  END IF;

  -- Its OWN series. Never buyback_invoice_no_seq: a proforma consuming a
  -- statutory invoice number leaves a hole in the tax sequence for a document
  -- that is not a tax invoice. Starts at 1001 — deliberately NOT aligned with
  -- the invoice series, so a PI number can never be mistaken for an INV number
  -- at a glance.
  IF to_regclass('public.buyback_proforma_no_seq') IS NULL THEN
    CREATE SEQUENCE buyback_proforma_no_seq START WITH 1001;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_proforma_status') THEN
    -- No RETURNED: nobody approves a proforma. It is our own statement of what
    -- we will charge, so it is either live, replaced, or withdrawn.
    CREATE TYPE buyback_proforma_status AS ENUM ('ISSUED', 'SUPERSEDED', 'CANCELLED');
  END IF;

  CREATE TABLE IF NOT EXISTS proforma_invoices (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id     UUID NOT NULL REFERENCES buyback_deals(id) ON DELETE CASCADE,
    -- The PO this answers. NOT NULL: "iTarang raises the PI AGAINST that PO" —
    -- a proforma that names no PO is answering nothing. No PO, no PI.
    po_id       UUID NOT NULL REFERENCES purchase_orders(id),
    number      TEXT NOT NULL,          -- 'PI-1001-V'
    pdf_s3      TEXT,
    status      buyback_proforma_status NOT NULL DEFAULT 'ISSUED',
    -- What we will charge, in whole rupees, derived server-side from
    -- deal_line_locks.vendor_price. Never taken from a client (invariant 2).
    total       NUMERIC(14,2) NOT NULL,
    issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_until TIMESTAMPTZ,
    created_by  UUID,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT proforma_total_positive_chk CHECK (total > 0)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS proforma_invoices_number_unique
    ON proforma_invoices (number);

  -- ONE LIVE PROFORMA PER DEAL. Same shape and same reason as E-187's
  -- invoices_one_live_per_deal_leg: a re-issue must SUPERSEDE, never
  -- duplicate — two live proformas means a vendor holding two different
  -- statements of what they owe, both apparently current. Superseded rows are
  -- kept, not deleted: the vendor may have paid against one.
  CREATE UNIQUE INDEX IF NOT EXISTS proforma_invoices_one_live_per_deal
    ON proforma_invoices (deal_id) WHERE status = 'ISSUED';

  CREATE INDEX IF NOT EXISTS proforma_invoices_po_idx ON proforma_invoices (po_id);

  CREATE TABLE IF NOT EXISTS proforma_invoice_lines (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    proforma_id    UUID NOT NULL REFERENCES proforma_invoices(id) ON DELETE CASCADE,
    line_id        UUID NOT NULL REFERENCES buyback_lines(id),
    quantity       INTEGER NOT NULL,
    price_per_unit NUMERIC(12,2) NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    -- NO tax columns. See the header: a proforma is tax-exclusive, so it has
    -- nowhere to put a treatment nobody has agreed to.
  );

  CREATE UNIQUE INDEX IF NOT EXISTS proforma_invoice_lines_unique
    ON proforma_invoice_lines (proforma_id, line_id);

  COMMENT ON TABLE proforma_invoices IS
    'E-196 — the document that answers the vendor''s PO (items 8/15, BRD step 3). A SEPARATE table from `invoices` on purpose: `invoices` is the TAX slot (INV-{n}-V, drawing on the statutory buyback_invoice_no_seq), and a proforma is not a tax document. Today''s vendor invoice is a proforma in substance — its own template declares it is not a tax invoice — wearing an invoice''s number and burning that series. This is the correct home for it; INV-{n}-V stays where it is and becomes a real tax invoice the day the GST/HSN treatment is ruled on (BRD §10).';
  COMMENT ON COLUMN proforma_invoices.po_id IS
    'E-196 — the vendor''s PO this proforma answers. NOT NULL because "against" is the whole point: no PO, no PI. `invoices` never modelled this link and reached its PO through an ad-hoc subquery for display only.';
  COMMENT ON COLUMN proforma_invoices.total IS
    'E-196 — server-derived from deal_line_locks.vendor_price (vendorReceipt). Never from a client: invariant 2 — clients supply evidence, never figures.';
  COMMENT ON INDEX proforma_invoices_one_live_per_deal IS
    'E-196 — a re-issue SUPERSEDES rather than duplicating. Two live proformas would mean a vendor holding two current statements of what they owe. Superseded rows are kept as evidence — they may have paid against one.';
END; $do$;
