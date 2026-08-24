-- ===========================================================================
-- E-261 — Per-battery counters in the scrap negotiation.
--
-- WHY
--   E-260 let the NBFC price each battery, but the answer could only ever be
--   one number for the pile: iTarang saw "₹8,000 / ₹9,000" and could reply
--   only "₹16,000 for the lot". The disagreement is usually about ONE battery
--   — the swollen pack the seller valued like the clean one — and a lot-level
--   counter cannot say which. The NBFC then has to guess where the cut landed.
--
-- WHAT
--   1. `scrap_consignment_offers.pricing_mode` — 'lot' (one number, what every
--      round was until now) or 'itemised' (a rate per battery). It describes
--      HOW THAT ROUND WAS EXPRESSED, independently of how the consignment was
--      first priced: a lot the NBFC itemised may be countered as a lot, and a
--      flat lot may be countered battery by battery. That is the flexibility
--      being added, and it is why this column lives on the round and not on
--      the consignment.
--   2. `scrap_consignment_offer_items` — the per-battery breakdown of one
--      round. Append-only, like the round log it hangs off: a superseded
--      round keeps its numbers, so "what did they say about THIS battery three
--      rounds ago" stays answerable.
--   3. `scrap_consignment_items.agreed_rate` — the per-battery split frozen at
--      acceptance, when the accepted round carried one.
--
-- `amount` STAYS AUTHORITATIVE. An itemised round writes the sum of its item
--   rates into `scrap_consignment_offers.amount`, exactly as a lot round writes
--   its single number there. Acceptance and payment read only that, so neither
--   has to know how the round was phrased.
--
-- Strictly additive. No DML, no backfill — every existing round is 'lot' by
-- default, which is what it was.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. How this round was expressed
-- ---------------------------------------------------------------------------
ALTER TABLE scrap_consignment_offers
  ADD COLUMN IF NOT EXISTS pricing_mode varchar(16) NOT NULL DEFAULT 'lot';

DO $do$ BEGIN
  ALTER TABLE scrap_consignment_offers
    ADD CONSTRAINT scrap_consignment_offers_pricing_mode_chk
    CHECK (pricing_mode IN ('lot', 'itemised'));
EXCEPTION
  WHEN duplicate_object THEN RAISE NOTICE 'offer pricing_mode check already present';
  WHEN undefined_table THEN RAISE NOTICE 'skip — table absent';
END; $do$;

-- ---------------------------------------------------------------------------
-- 2. The per-battery breakdown of one round
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scrap_consignment_offer_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id        uuid NOT NULL REFERENCES scrap_consignment_offers(id) ON DELETE CASCADE,
  -- Denormalised so the whole breakdown of a consignment is one indexed read
  -- rather than a join through every round.
  consignment_id  uuid NOT NULL,
  item_id         uuid NOT NULL REFERENCES scrap_consignment_items(id) ON DELETE CASCADE,
  -- Nullable for the same reason scrap_consignment_items.battery_id is: the
  -- battery master row can be re-pointed by a later recovery, and the item is
  -- the stable identity within the deal.
  battery_id      uuid,
  rate            numeric(12,2) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- One rate per battery per round. Without this a retried write would double
-- the round's total, since the total is a SUM over these rows.
CREATE UNIQUE INDEX IF NOT EXISTS scrap_consignment_offer_items_uidx
  ON scrap_consignment_offer_items (offer_id, item_id);

CREATE INDEX IF NOT EXISTS scrap_consignment_offer_items_consignment_idx
  ON scrap_consignment_offer_items (consignment_id, created_at);

-- ---------------------------------------------------------------------------
-- 3. The split that was actually agreed
-- ---------------------------------------------------------------------------
-- Set when the ACCEPTED round carried per-battery rates, and cleared when it
-- did not: a breakdown left over from an earlier round would not sum to
-- agreed_amount, and a wrong breakdown is worse than none.
ALTER TABLE scrap_consignment_items
  ADD COLUMN IF NOT EXISTS agreed_rate numeric(12,2);

-- ---------------------------------------------------------------------------
-- Self-documentation
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN scrap_consignment_offers.pricing_mode IS
  'E-261: lot = one number for the pile; itemised = a rate per battery in scrap_consignment_offer_items. Describes this ROUND, not the consignment — either side may switch at any round.';
COMMENT ON TABLE scrap_consignment_offer_items IS
  'E-261: the per-battery breakdown of one negotiation round. Append-only; a superseded round keeps its numbers. SUM(rate) equals the parent offer''s amount.';
COMMENT ON COLUMN scrap_consignment_items.agreed_rate IS
  'E-261: this battery''s share of the settled deal, frozen at acceptance when the accepted round was itemised. NULL when the deal was struck on a lot-level number.';
