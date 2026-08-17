-- E-242: the quotation DRAFT, and the record of sending it to the dealer.
--
-- WHY
--   E-221/E-226/E-230 built the decision. Nothing was ever built for what
--   happens after it. The approve branch of
--   api/dashboard/ceo/quotations/[commercialId]/decision writes a `quote_sent`
--   touchpoint whose own comment says "this is the moment the quote is actually
--   released to the dealer" — and then nothing is generated and nothing is sent.
--   The only quote document in the system is dealer_lead_commercials
--   .quote_document_url, a URL a rep types into a modal by hand.
--
--   The requirement (call of 2026-08-13) is that approval — by the CEO or by the
--   auto-rule — PRODUCES a draft in the business's own format, notifies the sales
--   manager, and lets them send it to the dealer over WhatsApp and email.
--
-- WHY NEW COLUMNS AND NOT quote_document_url
--   That column is the rep's own attachment: a brochure-and-numbers PDF they
--   made elsewhere and linked. It is written by the inside-sales commercials
--   route from user input and read by the lead detail pane and the CEO queue.
--   Overwriting it with a generated file would destroy what the rep attached and
--   make "the document on this quote" mean two different things depending on
--   which path last touched the row. The generated draft is a separate,
--   system-owned fact and gets its own columns.
--
-- WHY quote_snapshot
--   Same reasoning as E-226's oem_evaluation. The document is rendered from the
--   product masters, the price book, the tax rates and the company/bank block,
--   all of which move. A quotation re-opened six months later must still show
--   what it actually said, so the view the PDF was rendered from is stored with
--   it. Without this the only honest thing we could do is re-render, and
--   re-rendering can silently produce a different document under the same
--   number.
--
-- WHY A SEQUENCE AND NOT MAX(quote_number)+1
--   Two approvals can commit at the same instant — the CEO clicking approve
--   while the auto-rule releases another. MAX()+1 hands both the same number,
--   and the partial unique index below would then fail one approval for a
--   reason the CEO cannot act on. A sequence is the only allocation that is
--   correct under concurrency.
--
--   THE SERIES IS DELIBERATELY NOT ITPI-nn. Zoho Invoice mints ITPI numbers
--   (docs/ITPI-35 (1).pdf is ITPI-35) and still will, at invoicing time. Two
--   independent systems advancing one series will eventually issue two
--   documents with the same number, and the one that loses is a document
--   already in a dealer's inbox. CRM quotations are ITQ-<FY>-<nnnn>.
--
-- WHY hsn_code / gst_rate_pct ON THE MASTERS
--   The supplied format is a GST proforma: every line carries an HSN/SAC code
--   and its own rate (ITPI-35 has both 18% and 5% on one document). Neither
--   value exists anywhere today — product_master_batteries, _chargers and
--   _paraphernalia have no tax columns at all, and those three tables are what
--   dealer_lead_commercials.product_lines[].product_id points into. Putting the
--   rate on the model means it is set once by whoever maintains the catalogue
--   rather than re-keyed, and mis-keyed, on every quote.
--
--   BOTH ARE NULLABLE AND THERE IS NO BACKFILL. A guessed rate is a wrong number
--   on a tax document sent to a dealer. NULL means "nobody has set this", the
--   renderer shows it as unset rather than as zero, and the catalogue fills in
--   product by product.
--
-- WHY quotation_dispatches AND NOT buyback_notification_events
--   That table is the closest existing thing — durable, retrying, multi-channel,
--   carries attachments. It is also NOT NULL on request_id with a foreign key to
--   buyback_requests, so a dealer-lead quotation cannot have a row in it without
--   inventing a buyback request. Reusing it would mean widening a buyback FK for
--   a non-buyback flow.
--
-- Free text on the varchars, no CHECK and no enum, per this table family's
-- convention (cf. E-202, E-218, E-220, E-221, E-226, E-230). The vocabulary
-- lives in src/lib/leads/quoteDispatch.ts and is enforced by zod at the write
-- path.
--
-- WHAT IS MIRRORED IN schema.ts, AND WHAT IS NOT
--   dealer_lead_commercials AND quotation_dispatches ARE mirrored. Drizzle names
--   every column of a table object in its INSERT, so the inside-sales
--   commercials route 500s with `column "quote_number" does not exist` until
--   this file is applied. That is the same trade E-226 made on the same table
--   and the blast radius is the quotation flow, which is what this file is for.
--
--   dealer_leads.contact_email AND dealer_leads.gstin ARE **NOT** mirrored,
--   following E-224 and E-236. Drizzle also names every column in a bare
--   `db.select().from(dealerLeads)`, and there are ~20 of those — the leads
--   list, the AI dialer, the CEO overview, the role dashboards. Listing these
--   two on the object would hard-fail all of them at PARSE time on a database
--   without this file: the entire leads screen goes down to add an email field.
--   They are read by name in raw `sql`` projections instead
--   (src/lib/leads/quoteDraft.ts and the send route), so an unapplied E-242
--   costs the quotation feature and nothing else.
--
-- DEPENDS ON E-221, E-226, E-230 — apply those first.
--
-- Additive and idempotent — safe to re-run.

BEGIN;

-- ── 1. The generated draft, on the quote it belongs to ───────────────────────

ALTER TABLE dealer_lead_commercials
  ADD COLUMN IF NOT EXISTS quote_number           varchar(40),
  ADD COLUMN IF NOT EXISTS quote_pdf_url          text,
  ADD COLUMN IF NOT EXISTS quote_pdf_generated_at timestamptz,
  ADD COLUMN IF NOT EXISTS quote_pdf_error        text,
  ADD COLUMN IF NOT EXISTS quote_snapshot         jsonb;

COMMENT ON COLUMN dealer_lead_commercials.quote_number IS
  'E-242: human-readable quotation number, ITQ-<FY>-<nnnn>, with -R<n> on a '
  'revision. Allocated from quotation_number_seq at draft generation, so only '
  'an APPROVED quote ever consumes one. NULL on every pre-E-242 row and on any '
  'quote whose draft has not been generated.';

COMMENT ON COLUMN dealer_lead_commercials.quote_pdf_url IS
  'E-242: the SYSTEM-generated draft, in the business quotation format. '
  'Distinct from quote_document_url, which is whatever file the rep attached by '
  'hand — this column is written only by generateQuotationDraft() and only '
  'after approval.';

COMMENT ON COLUMN dealer_lead_commercials.quote_pdf_error IS
  'E-242: why the last generation attempt failed, NULL when it succeeded. The '
  'draft is rendered AFTER the approval transaction commits, so a rendering '
  'failure must not roll back a decision the CEO has already made; it is '
  'recorded here instead and the sales manager is told to retry rather than '
  'left waiting for a document that will never arrive.';

COMMENT ON COLUMN dealer_lead_commercials.quote_snapshot IS
  'E-242: the exact view the PDF was rendered from — parties, place of supply, '
  'per-line HSN/rate/amount, tax split and totals. The masters, the price book '
  'and the company block all move; this is what makes a quotation re-opened '
  'later still show what it actually said. Same reasoning as oem_evaluation.';

-- Partial: only rows that HAVE a number take part, so the pre-E-242 rows (all
-- NULL) cannot collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS dealer_lead_commercials_quote_number_uniq
  ON dealer_lead_commercials (quote_number)
  WHERE quote_number IS NOT NULL;

-- The number allocator. Owned by no table on purpose — it is consumed by
-- nextQuoteNumber() inside the generation transaction, not by a column default.
CREATE SEQUENCE IF NOT EXISTS quotation_number_seq;

COMMENT ON SEQUENCE quotation_number_seq IS
  'E-242: allocates the <nnnn> in ITQ-<FY>-<nnnn>. A sequence rather than '
  'MAX()+1 because two approvals can commit simultaneously. Deliberately not '
  'the ITPI series, which Zoho Invoice still owns.';

-- ── 2. What the GST proforma format needs and nothing stored ─────────────────

ALTER TABLE product_master_batteries
  ADD COLUMN IF NOT EXISTS hsn_code     varchar(8),
  ADD COLUMN IF NOT EXISTS gst_rate_pct numeric(5,2);

ALTER TABLE product_master_chargers
  ADD COLUMN IF NOT EXISTS hsn_code     varchar(8),
  ADD COLUMN IF NOT EXISTS gst_rate_pct numeric(5,2);

ALTER TABLE product_master_paraphernalia
  ADD COLUMN IF NOT EXISTS hsn_code     varchar(8),
  ADD COLUMN IF NOT EXISTS gst_rate_pct numeric(5,2);

COMMENT ON COLUMN product_master_batteries.gst_rate_pct IS
  'E-242: GST rate for this model as a percentage (18.00, 5.00). NULL means '
  'nobody has set it — the quotation renders the line as UNSET rather than as '
  'zero, because a zero-rated line on a tax document is a claim, not a blank.';

COMMENT ON COLUMN product_master_batteries.hsn_code IS
  'E-242: HSN/SAC code printed on the quotation line. NULL = not yet set.';

COMMENT ON COLUMN product_master_chargers.gst_rate_pct IS
  'E-242: see product_master_batteries.gst_rate_pct.';
COMMENT ON COLUMN product_master_chargers.hsn_code IS
  'E-242: see product_master_batteries.hsn_code.';
COMMENT ON COLUMN product_master_paraphernalia.gst_rate_pct IS
  'E-242: see product_master_batteries.gst_rate_pct.';
COMMENT ON COLUMN product_master_paraphernalia.hsn_code IS
  'E-242: see product_master_batteries.hsn_code.';

-- ── 3. Who the document is billed and sent to ───────────────────────────────
--
-- dealer_leads carries a phone (UNIQUE) but has never had an email address, so
-- the email channel had no recipient to resolve. gstin is needed for the Bill To
-- block and to decide the tax split.

ALTER TABLE dealer_leads
  ADD COLUMN IF NOT EXISTS gstin         varchar(15),
  ADD COLUMN IF NOT EXISTS contact_email text;

COMMENT ON COLUMN dealer_leads.contact_email IS
  'E-242: dealer email for sending the quotation. Prefills the send dialog and '
  'is written back when the sales manager corrects it, so the address is '
  'captured once rather than retyped per revision. NOT unique — dealer_leads '
  'already dedupes on phone, and two branches of one firm can share an inbox.';

COMMENT ON COLUMN dealer_leads.gstin IS
  'E-242: dealer GSTIN for the quotation Bill To block. NULL is legal and '
  'common — a lead at quotation stage is often not onboarded yet — and the '
  'document simply omits the line.';

-- ── 4. The record of actually sending it ────────────────────────────────────

CREATE TABLE IF NOT EXISTS quotation_dispatches (
  dispatch_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commercial_id       uuid        NOT NULL,
  dealer_lead_id      text        NOT NULL,
  channel             varchar(20) NOT NULL,
  recipient           text        NOT NULL,
  status              varchar(20) NOT NULL,
  provider_message_id text,
  error               text,
  sent_by             text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE quotation_dispatches IS
  'E-242: one row per channel per send attempt of a quotation draft. Append-'
  'only — a resend is a new row, never an update, so "we sent this three times '
  'and the first two bounced" is answerable. Not buyback_notification_events: '
  'that table is NOT NULL on request_id with an FK to buyback_requests.';

COMMENT ON COLUMN quotation_dispatches.channel IS
  'E-242: email | whatsapp. Free text, no CHECK; vocabulary in '
  'src/lib/leads/quoteDispatch.ts.';

COMMENT ON COLUMN quotation_dispatches.status IS
  'E-242: sent | failed. The channels are dispatched independently — WhatsApp '
  'failing must not undo a delivered email — so one send can write one row of '
  'each.';

COMMENT ON COLUMN quotation_dispatches.recipient IS
  'E-242: the address or number actually used, snapshotted. The lead''s email '
  'can be corrected later; this stays what the message went to.';

-- No FK on commercial_id: this table family carries none
-- (dealer_lead_commercials has no FKs either).
CREATE INDEX IF NOT EXISTS quotation_dispatches_commercial_idx
  ON quotation_dispatches (commercial_id, created_at DESC);

CREATE INDEX IF NOT EXISTS quotation_dispatches_lead_idx
  ON quotation_dispatches (dealer_lead_id, created_at DESC);

-- No backfill anywhere in this file. Every existing quote was decided before a
-- draft could be generated and before anything could be sent; NULL and "no
-- dispatch rows" are the true statements about them.

COMMIT;
