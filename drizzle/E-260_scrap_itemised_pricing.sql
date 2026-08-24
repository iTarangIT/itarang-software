-- ===========================================================================
-- E-260 — Per-battery pricing on a scrap consignment.
--
-- WHY
--   E-258 priced a consignment as ONE rate × battery_count. That is right for
--   a pile of identical dead cells and wrong for the lots NBFCs actually hold,
--   where a 48V pack with an intact casing and a swollen 60V pack are not the
--   same money. The NBFC's only way to reflect that was to split the lot into
--   several consignments and negotiate each one separately.
--
-- WHAT
--   1. `scrap_consignments.pricing_mode` — 'flat' (one rate for every battery,
--      exactly what shipped) or 'itemised' (a rate per battery). Defaults to
--      'flat', so every existing row keeps the behaviour it was created under
--      without a backfill.
--   2. `scrap_consignment_items.asking_rate` — the NBFC's price for THAT
--      battery. NULL in flat mode, where the header rate covers everything.
--   3. `scrap_consignments.asking_amount` — the total asked, written in BOTH
--      modes. It removes the "which field is authoritative" question from
--      every downstream read: flat writes rate × count into it, itemised
--      writes the sum of the item rates, and the negotiation, the payout and
--      the UI all read the one column.
--
-- THE NEGOTIATION IS ON THE TOTAL.
--   `scrap_consignment_offers.amount` already existed and already carried it;
--   what changes is that it is now the number being argued over rather than a
--   derived display value. An itemised counter names a total for the lot, not
--   a new set of per-battery numbers — a buyer bids on the pile. The NBFC's
--   per-battery breakdown is its justification for the asking total and is
--   kept as submitted; it is not re-derived when a total is countered, which
--   is why `asking_rate` is deliberately never rewritten after submission.
--
-- BACKFILL: one UPDATE, and only of `asking_amount`, for rows that predate the
--   column. It is a pure restatement of rate × count — the number those rows
--   already negotiate on — not a new fact, and without it an existing open
--   consignment would read as having no total. Guarded to touch only rows
--   where the column is NULL and a rate exists.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. How this consignment is priced
-- ---------------------------------------------------------------------------
ALTER TABLE scrap_consignments
  ADD COLUMN IF NOT EXISTS pricing_mode varchar(16) NOT NULL DEFAULT 'flat';

DO $do$ BEGIN
  ALTER TABLE scrap_consignments
    ADD CONSTRAINT scrap_consignments_pricing_mode_chk
    CHECK (pricing_mode IN ('flat', 'itemised'));
EXCEPTION
  WHEN duplicate_object THEN RAISE NOTICE 'pricing_mode check already present';
  WHEN undefined_table THEN RAISE NOTICE 'skip — table absent';
END; $do$;

-- ---------------------------------------------------------------------------
-- 2. The total, in both modes
-- ---------------------------------------------------------------------------
ALTER TABLE scrap_consignments
  ADD COLUMN IF NOT EXISTS asking_amount numeric(14,2);

-- ---------------------------------------------------------------------------
-- 3. The per-battery price
-- ---------------------------------------------------------------------------
ALTER TABLE scrap_consignment_items
  ADD COLUMN IF NOT EXISTS asking_rate numeric(12,2);

-- ---------------------------------------------------------------------------
-- 4. Restate the total for rows that predate the column
-- ---------------------------------------------------------------------------
-- Not a new fact: rate × count is the number these consignments are already
-- negotiating on, and every one of them is 'flat' because that is the only
-- mode that existed when they were made.
UPDATE scrap_consignments
   SET asking_amount = asking_rate_per_battery * battery_count
 WHERE asking_amount IS NULL
   AND asking_rate_per_battery IS NOT NULL
   AND battery_count > 0;

-- ---------------------------------------------------------------------------
-- Self-documentation
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN scrap_consignments.pricing_mode IS
  'E-260: flat = one asking_rate_per_battery for the whole lot; itemised = a rate per scrap_consignment_items row. Defaults to flat.';
COMMENT ON COLUMN scrap_consignments.asking_amount IS
  'E-260: the total asked, in BOTH modes. flat = asking_rate_per_battery × battery_count; itemised = SUM(scrap_consignment_items.asking_rate). The negotiation runs on this, not on the rate.';
COMMENT ON COLUMN scrap_consignment_items.asking_rate IS
  'E-260: the NBFC price for this one battery. NULL in flat mode. Never rewritten after submission — it is the breakdown behind the asking total, not a running per-battery negotiation.';
