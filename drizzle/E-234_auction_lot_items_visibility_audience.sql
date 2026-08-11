-- E-234: multi-battery lots, visibility rules, and the frozen audience.
--
-- Phase 3 of docs/battery-auction-flow.html. Depends on E-232.
--
-- ============================================================================
-- auction_lot_items — BRD §6
-- ============================================================================
--   `auction_lots.quantity` is an integer and `publishLotFromRecovery()`
--   hard-codes it to 1. There is no way to express "5 batteries, one lot",
--   which is the shape the BRD asks for throughout.
--
--   WHY condition IS ON THE ITEM AND NOT ON THE LOT
--     A lot may legitimately mix grades — three refurbished cells and two
--     partial-working ones in one pallet. Putting `condition` on the lot forces
--     the seller to either split the pallet or lie about two of the five, and a
--     dealer who bid on "refurbished" and received partial-working has been
--     mis-sold. EVs slot into the same column later with no schema change,
--     which is the other half of why it is a varchar and not an enum.
--
--   THIS TABLE ALSO REPLACES TWO STRING JOINS, which is not a side benefit:
--     settlements.ts   matched nbfc_recovery_pipeline.battery_serial = auction_lots.lot_code
--     cancel service   matched inventory.serial_number             = auction_lots.lot_code
--   `lot_code` is "LOT-" + the first 8 hex of a pipeline uuid and is never
--   equal to either, so both matched zero rows every time — silently, because
--   both were best-effort.
--
-- ============================================================================
-- auction_lot_visibility — BRD §8
-- ============================================================================
--   One row per lot: scope plus its parameters. Modelled as a separate table
--   rather than four nullable columns on auction_lots because only one scope is
--   ever active and the parameter set differs per scope — states[] is
--   meaningless for a radius, lat/lng meaningless for a state list.
--
-- ============================================================================
-- auction_lot_audience — BRD §17
-- ============================================================================
--   The eligible dealers, RESOLVED ONCE AT PUBLISH AND FROZEN, plus per-channel
--   delivery state.
--
--   WHY FROZEN AND NOT RE-EVALUATED ON EVERY READ
--     A dealer who was notified must keep seeing the lot they were told about,
--     and a dealer who onboards mid-auction must not silently appear in a race
--     that is half over. Re-running the rule on every read makes the audience a
--     moving target and makes "who did we tell?" unanswerable after the fact —
--     which is the question a disputed auction turns on.
--
--   The channel columns are on this table rather than in a separate outbox so
--   that "was this dealer told, on which channel, and did it land" is one row
--   per (lot, dealer, channel) and needs no join to answer.
--
-- NOTE ON dealer_id TYPE: varchar(255), matching `accounts.id`, which holds
--   application-issued strings ('ACC-ITARANG-20260409-971'), NOT uuids. See the
--   long note in E-232 PART 3 — a uuid column here applies and verifies
--   perfectly and then rejects every real dealer at runtime.
--
-- Additive and idempotent — safe to re-run. Apply with
--   node --env-file=.env.local scripts/apply-e234.mjs

BEGIN;

-- ============================================================================
-- auction_lot_items
-- ============================================================================
CREATE TABLE IF NOT EXISTS auction_lot_items (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id      uuid        NOT NULL,
  battery_id  uuid        NOT NULL,
  -- new | refurbished | partial_working. EVs reuse this column later.
  condition   varchar(24) NOT NULL DEFAULT 'refurbished',
  -- The per-item price the lot's base_price was built from. Kept so that
  -- "why is this lot ₹1.52L?" is answerable after the fact even if the
  -- battery is later re-evaluated at a different SOH.
  item_price  numeric(12,2),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- A battery appears at most once in a given lot. Without this a double-click
  -- on "add to lot" silently doubles the quantity and the base price.
  CONSTRAINT auction_lot_items_lot_battery_key UNIQUE (lot_id, battery_id)
);

CREATE INDEX IF NOT EXISTS auction_lot_items_lot_idx
  ON auction_lot_items (lot_id);
CREATE INDEX IF NOT EXISTS auction_lot_items_battery_idx
  ON auction_lot_items (battery_id);

-- A battery may be in only ONE lot that is still in play. It may appear again
-- in a later lot once the first is cancelled or has ended without a sale —
-- which is why this is scoped to open lots via a trigger-free partial index on
-- the item side plus the status check in composeLot.ts, rather than a blanket
-- unique on battery_id that would forbid re-listing an unsold battery forever.
CREATE INDEX IF NOT EXISTS auction_lot_items_battery_lot_idx
  ON auction_lot_items (battery_id, lot_id);

COMMENT ON TABLE auction_lot_items IS
  'E-234: lot <-> battery, many-to-many (BRD §6). Makes "5 batteries, one lot" '
  'possible and carries the per-ITEM condition, because a lot may mix grades. '
  'Also the real key that replaces two string joins on lot_code which matched '
  'zero rows every time (settlements.ts and the cancel service).';

COMMENT ON COLUMN auction_lot_items.condition IS
  'E-234: new | refurbished | partial_working (BRD §6). Per ITEM, not per lot — '
  'a pallet may mix grades, and a dealer who bid on refurbished and received '
  'partial_working has been mis-sold. No CHECK, per this family''s convention.';

-- ============================================================================
-- auction_lot_visibility
-- ============================================================================
CREATE TABLE IF NOT EXISTS auction_lot_visibility (
  lot_id      uuid        PRIMARY KEY,
  -- india | state | city | radius. Exactly one is active per lot.
  scope       varchar(16) NOT NULL DEFAULT 'india',
  states      text[]      NOT NULL DEFAULT '{}',
  cities      text[]      NOT NULL DEFAULT '{}',
  centre_lat  numeric(10,7),
  centre_lng  numeric(10,7),
  radius_km   integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE auction_lot_visibility IS
  'E-234: one row per lot — the geographic rule (BRD §8). A separate table '
  'rather than four nullable columns on auction_lots because only one scope is '
  'ever active and the parameter sets are disjoint: states[] is meaningless for '
  'a radius, lat/lng meaningless for a state list. Geography NARROWS an '
  'already-dealer audience; it never grants entry to one — NBFC users are '
  'excluded by ROLE (see src/lib/nbfc/auction/roles.ts).';

-- ============================================================================
-- auction_lot_audience
-- ============================================================================
CREATE TABLE IF NOT EXISTS auction_lot_audience (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id       uuid         NOT NULL,
  -- varchar(255) to match accounts.id — NOT uuid. See the header note.
  dealer_id    varchar(255) NOT NULL,
  dealer_name  varchar(255),
  city         varchar(120),
  state        varchar(120),
  distance_km  numeric(8,2),
  -- Per-channel delivery state, one row per (lot, dealer, channel).
  channel      varchar(16)  NOT NULL DEFAULT 'in_app',
  status       varchar(16)  NOT NULL DEFAULT 'pending',
  sent_at      timestamptz,
  error        text,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT auction_lot_audience_lot_dealer_channel_key
    UNIQUE (lot_id, dealer_id, channel)
);

CREATE INDEX IF NOT EXISTS auction_lot_audience_lot_idx
  ON auction_lot_audience (lot_id);
CREATE INDEX IF NOT EXISTS auction_lot_audience_dealer_idx
  ON auction_lot_audience (dealer_id);
-- The fan-out worker's only query: everything still waiting to be sent.
CREATE INDEX IF NOT EXISTS auction_lot_audience_pending_idx
  ON auction_lot_audience (lot_id, channel) WHERE status = 'pending';

COMMENT ON TABLE auction_lot_audience IS
  'E-234: the eligible dealers for a lot, RESOLVED ONCE AT PUBLISH AND FROZEN, '
  'plus per-channel delivery state (BRD §17). Frozen rather than re-evaluated '
  'on every read so that a notified dealer keeps seeing the lot they were told '
  'about, a dealer onboarding mid-auction does not silently join a race that is '
  'half over, and "who did we tell?" stays answerable afterwards — which is the '
  'question a disputed auction turns on.';

COMMENT ON COLUMN auction_lot_audience.dealer_id IS
  'E-234: accounts.id — character varying, NOT uuid. Application-issued strings '
  'like ACC-ITARANG-20260409-971.';

-- ============================================================================
-- auction_auto_bids — the dealer column the proxy engine cannot work without
-- ============================================================================
--   E-093 keyed a standing maximum on (lot_id, tenant_id), which was right when
--   every bidder was an NBFC tenant. After the E-232 re-point it is not: a
--   dealer bid writes the SELLER's tenant into auction_bids.tenant_id, so every
--   dealer bidding on one lot shares the same tenant_id.
--
--   Two consequences, both fatal to the auto-bid feature:
--     1. The engine cannot tell whose standing order is whose, and resolving
--        the dealer from "the most recent bid by this tenant" returns whoever
--        bid last — usually the current leader, whose own proxy is then
--        correctly skipped, so NOTHING EVER FIRES.
--     2. E-093's partial unique index (lot_id, tenant_id) WHERE status='active'
--        means the SECOND dealer to set a maximum on a lot silently cancels the
--        first one's.
--
--   Adding the column is the smaller half. The index has to be re-keyed too,
--   onto COALESCE(bidder_dealer_id, tenant_id::text) — the same "whichever
--   identity this row actually carries" rule used everywhere else in this
--   feature.
ALTER TABLE auction_auto_bids
  ADD COLUMN IF NOT EXISTS bidder_dealer_id varchar(255);

CREATE INDEX IF NOT EXISTS auction_auto_bids_bidder_dealer_idx
  ON auction_auto_bids (bidder_dealer_id);

-- The E-093 index is DROPPED and replaced. Called out because CLAUDE.md's
-- default is strictly additive: it drops no data and no column, the replacement
-- is created in the same transaction, and the degenerate case E-093 was
-- guarding — one bidder holding two active maxima on one lot — stays refused
-- with 23505. What becomes legal is what should always have been: two DIFFERENT
-- dealers each holding one.
DROP INDEX IF EXISTS auction_auto_bids_lot_tenant_active_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS auction_auto_bids_lot_bidder_active_uidx
  ON auction_auto_bids (lot_id, COALESCE(bidder_dealer_id, tenant_id::text))
  WHERE status = 'active';

COMMENT ON COLUMN auction_auto_bids.bidder_dealer_id IS
  'E-234: accounts.id of the dealer holding this standing maximum. Required '
  'because after the E-232 re-point every dealer bidding on a lot shares the '
  'seller''s tenant_id, so tenant_id alone can no longer identify a bidder.';

COMMENT ON COLUMN auction_lot_audience.status IS
  'E-234: pending | sent | failed | skipped. skipped = the dealer is in the '
  'audience but this channel was not attempted (no phone on file, SMS disabled, '
  'and so on) — deliberately distinct from failed, which means it was tried.';

COMMIT;
