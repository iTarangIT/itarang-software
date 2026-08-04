-- E-226: OEM reference prices, and quotation auto-approval from them.
--
-- WHY
--   E-221 put EVERY quote behind the CEO — initialApprovalStatus() returns
--   'pending' for every quote_issue / quote_revision with no regard for the
--   number being quoted. That makes the CEO a bottleneck on quotes that need no
--   judgement at all. The gate should fire only where it earns its cost: when a
--   rep quotes BELOW our reference price. At or above it, the quote releases to
--   the dealer immediately.
--
--   The blocker was that no OEM reference price existed anywhere:
--     product_master_batteries       — no price column at all
--     product_master_paraphernalia   — no price column at all
--     product_master_chargers        — base_price, no history, destructive on edit
--     products.price                 — legacy integer with NO write path in any
--                                      API; only direct SQL has ever changed it
--     oems                           — a GSTIN/PAN supplier record, not a price
--
--   So this file builds the price repository first. dealer_lead_commercials
--   already carries product_lines (E-128) with a product_id that IS
--   product_master_*.id::text, so the mapping the rule needs already exists.
--
-- WHY A TABLE AND NOT A COLUMN ON product_master_*
--   Two of the three masters have no price column to extend, and a column
--   cannot hold history — the requirement is explicitly to preserve historical
--   prices for audit. One table covers all three asset types uniformly and IS
--   the single source of truth. This is the shape calc_component_prices (E-177)
--   already uses for prices that must reproduce a past quote.
--
-- WHY APPEND-ONLY
--   A price revision never UPDATEs oem_price. It closes the live row
--   (effective_to = now()) and inserts a new one, in one transaction. The
--   partial unique index makes "two live prices for one product"
--   unrepresentable, so "the latest price" is a lookup, not a computation, and
--   yesterday's price is still on disk when someone asks why a quote was
--   approved three revisions ago.
--
-- WHY product_id IS text AND NOT uuid
--   It joins to dealer_lead_commercials.product_lines[].product_id, which the
--   picker (src/app/api/inside-sales/products/route.ts) already emits as
--   id::text. Storing the same type keeps the hot lookup off a cast.
--
-- WHY NO FOREIGN KEY
--   The parent is one of THREE tables, chosen by asset_type — a single FK is
--   not expressible. This table family carries no FKs anyway
--   (dealer_lead_commercials has none either).
--
-- NO BACKFILL — SHIPS EMPTY, ON PURPOSE
--   product_master_chargers.base_price is NOT migrated in. A "base price" and
--   an "OEM reference price" are different assurances, and seeding one as the
--   other would let a number nobody chose for this purpose start
--   auto-approving quotes. With the table empty and the rule fail-closed, day-1
--   behaviour is identical to today (everything pending); auto-approval switches
--   itself on product by product as real prices are loaded. No flag, no cutover.
--
-- Free text, no CHECK and no enum, per this table family's convention
-- (cf. E-202_dealer_type, E-218_expense_buckets, E-220, E-221, E-223, E-225).
-- The vocabulary lives in src/lib/leads/oemPricing.ts and is enforced by zod at
-- the write path.
--
-- REQUIRED: Drizzle names approval_mode and oem_evaluation in every
-- dealer_lead_commercials INSERT, so the inside-sales commercials route 500s
-- with "column approval_mode does not exist" without this file.
-- DEPENDS ON E-221_lead_quote_approval — apply that first.
--
-- Additive and idempotent — safe to re-run.

-- ── 1. The price repository ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS oem_reference_prices (
  price_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_type     varchar(30)   NOT NULL,
  product_id     text          NOT NULL,
  model_id       varchar(100),
  product_name   varchar(200),
  oem_price      numeric(14,2) NOT NULL,
  effective_from timestamptz   NOT NULL DEFAULT now(),
  effective_to   timestamptz,
  note           text,
  created_by     text          NOT NULL,
  created_at     timestamptz   NOT NULL DEFAULT now()
);

COMMENT ON TABLE oem_reference_prices IS
  'E-226: append-only OEM reference price book. One live row per '
  '(asset_type, product_id) — effective_to IS NULL. A revision closes the live '
  'row and inserts a new one; oem_price is never updated in place, so the '
  'history stays auditable.';

COMMENT ON COLUMN oem_reference_prices.asset_type IS
  'E-226: battery | charger | paraphernalia — selects which product_master_* '
  'table product_id points into. Free text, no CHECK; vocabulary in '
  'src/lib/leads/oemPricing.ts.';

COMMENT ON COLUMN oem_reference_prices.product_id IS
  'E-226: product_master_*.id AS TEXT. Matches '
  'dealer_lead_commercials.product_lines[].product_id exactly, which is the '
  'whole point — it is the join key the auto-approval rule reads.';

COMMENT ON COLUMN oem_reference_prices.effective_to IS
  'E-226: NULL means this is the live price. A closed row is history and is '
  'never read by the approval rule, only by the audit drawer.';

COMMENT ON COLUMN oem_reference_prices.product_name IS
  'E-226: denormalised snapshot of the master name at the time the price was '
  'set, so a renamed or deactivated product still reads sensibly in history.';

-- Exactly one live price per product. This is the invariant the whole feature
-- rests on: without it "the latest price" would be a MAX(effective_from) race.
CREATE UNIQUE INDEX IF NOT EXISTS oem_reference_prices_live_uniq
  ON oem_reference_prices (asset_type, product_id)
  WHERE effective_to IS NULL;

-- The history drawer reads one product newest-first.
CREATE INDEX IF NOT EXISTS oem_reference_prices_product_idx
  ON oem_reference_prices (product_id, effective_from DESC);

-- ── 2. How the decision was reached, on the quote itself ─────────────────────
--
-- approval_status KEEPS its existing three values ('pending' | 'approved' |
-- 'rejected'). Adding a fourth would have to be taught to every site that
-- compares it to a string literal, and one missed site reads an approved quote
-- as unapproved — the same reasoning E-225 applied to agreement_status.
-- approval_mode answers HOW the decision was made; approval_status answers
-- WHETHER it is approved. The two are orthogonal.

ALTER TABLE dealer_lead_commercials
  ADD COLUMN IF NOT EXISTS approval_mode  varchar(16),
  ADD COLUMN IF NOT EXISTS oem_evaluation jsonb;

COMMENT ON COLUMN dealer_lead_commercials.approval_mode IS
  'E-226: auto | manual. NULL on every pre-E-226 row and on ungated events — '
  'those decisions were made before an automatic path existed, and saying so '
  'is more honest than backfilling a guess.';

COMMENT ON COLUMN dealer_lead_commercials.oem_evaluation IS
  'E-226: the price check that produced approval_status, snapshotted at quote '
  'time — rule version, outcome, reason, shortfall_total and one verdict per '
  'line carrying the price_id actually used. Because it records price_id and '
  'the reference amount, a quote read three price revisions later still shows '
  'the number it was judged against. This is the audit record.';

-- No backfill of either column. NULL is the correct value for a row decided
-- before this rule existed; writing anything else would invent a check that
-- never ran.
