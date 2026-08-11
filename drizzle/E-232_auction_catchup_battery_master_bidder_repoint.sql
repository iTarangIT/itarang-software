-- E-232: the battery-auction foundation — catch-up DDL, the battery master, and
--        the bidder re-point from NBFC tenant to dealer account.
--
-- Implements Phase 0 of docs/battery-auction-flow.html.
--
-- ============================================================================
-- PART 1 — CATCH-UP. WHY THIS IS FIRST, AND WHY IT IS THE HIGHEST-RISK HALF
-- ============================================================================
--   Six of the nine tables in the auction/recovery family have NO migration
--   file anywhere in drizzle/:
--       auction_lots, auction_bids, auction_settlements,
--       nbfc_recovery_pipeline, nbfc_auction_lot_actions,
--       nbfc_auction_cancel_requests
--   They exist in src/lib/db/schema.ts and in whichever database happened to
--   receive a `npm run db:push`. Only three of the family were ever migrated
--   properly: auction_auto_bids (E-093), nbfc_battery_evaluations (E-119) and
--   nbfc_buyback_requests (E-118). E-129 seeds demo rows into a table it never
--   creates.
--
--   That is a live hazard for PART 3 below: `ALTER TABLE auction_lots ADD
--   COLUMN ...` does not fail softly on a database that never got the push, it
--   aborts the whole file with 42P01. So the CREATEs come first, in the same
--   file, and the ALTERs are guaranteed to have something to alter.
--
--   On a database that already has these tables PART 1 is a pure no-op. It is
--   transcribed from schema.ts verbatim (column order, types, nullability,
--   defaults, index names) so that the two cannot drift further apart. Where
--   schema.ts declares .unique() without naming the constraint, the name here
--   is Postgres's own default (<table>_<column>_key), which is what db:push
--   would have produced.
--
-- ============================================================================
-- PART 2 — recovery_batteries: the battery master the BRD asks for
-- ============================================================================
--   BRD §3 wants serial, images, model, capacity, condition, location and
--   recovery date per recovered battery. Today nbfc_recovery_pipeline stores a
--   serial string and a stage and nothing else — seven columns total, no photos,
--   no location, no link back to the loan it came off.
--
--   This is deliberately a SEPARATE table rather than 12 more columns on
--   nbfc_recovery_pipeline, because the two have different lifetimes: the
--   pipeline row is a workflow position that ends at 'resold', while the battery
--   is a physical asset that outlives the pipeline row, gets refurbished, sold,
--   refinanced and can come back through recovery a second time. One battery,
--   many pipeline passes.
--
-- ============================================================================
-- PART 3 — the bidder re-point. THE structural change of this BRD.
-- ============================================================================
--   auction_bids.tenant_id is the BIDDING NBFC's tenant (see the schema.ts
--   comment at ~L6244). The BRD says the opposite: dealers are the only bidders
--   and other NBFCs must never see, let alone bid on, a lot.
--
--   bidder_dealer_id is added ALONGSIDE tenant_id, never instead of it:
--     - tenant_id is NOT NULL and dropping that would rewrite the table;
--     - existing NBFC-to-NBFC bids stay readable and their audit trail intact;
--     - the column can be retired later, in its own migration, once nothing
--       writes it (per CLAUDE.md's two-step rule for destructive change).
--
--   For a dealer bid, tenant_id carries the SELLER's tenant (the lot owner).
--   That is not a fudge — it is what makes the nbfc_audit_log row for the bid
--   land in the right tenant's log, and what keeps every existing tenant-scoped
--   index and query on auction_bids meaningful. bidder_kind says which of the
--   two identity columns is authoritative, so nothing has to infer it from
--   NULLness (a dealer bid has BOTH columns populated).
--
--   auction_lots.seller_tenant_id fixes a shipped defect for free:
--   approveWinningBid() currently writes a zero-UUID sentinel into
--   auction_settlements.seller_tenant_id because the seller genuinely is not
--   knowable at that layer, and listSettlements() then filters on
--   seller_tenant_id = caller — so EVERY settlement ever created by that route
--   is invisible to every NBFC. The lot has to know its own seller.
--
--   auction_lots.status gains 'draft' and 'scheduled' as legal values. NO CHECK
--   CONSTRAINT is added, per this family's convention (cf. E-202, E-218, E-220,
--   E-226, E-231) — vocabulary is enforced at the write path in
--   src/lib/nbfc/auction/, not in SQL, so that a status can be added in code
--   without a migration on a drifting DB.
--
--   The DEFAULT on auction_lots.status is deliberately NOT changed from 'live'
--   to 'draft'. Changing it would silently alter the behaviour of any INSERT
--   that omits the column, and the one writer that omits nothing is
--   publishLotFromRecovery(). The draft default is set in code instead, where it
--   is reviewable.
--
-- REQUIRED? YES, for the auction feature — Drizzle names every column of the
--   table object in its INSERTs, so once schema.ts mirrors these columns an
--   unapplied database throws `column "..." does not exist` on the first bid or
--   lot write. PART 1 alone is safe to run anywhere.
--
-- Additive and idempotent throughout — safe to re-run. Apply with
--   node --env-file=.env.local scripts/apply-e232.mjs

BEGIN;

-- ============================================================================
-- PART 1 — CATCH-UP DDL (no-op where db:push already created these)
-- ============================================================================

-- E-036 — recovery pipeline (Section 6.1.7)
CREATE TABLE IF NOT EXISTS nbfc_recovery_pipeline (
  id                       uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid         NOT NULL,
  battery_serial           varchar(64)  NOT NULL,
  stage                    varchar(32)  NOT NULL,
  estimated_recovery_value numeric(12,2),
  created_at               timestamptz  DEFAULT now(),
  updated_at               timestamptz  DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nbfc_recovery_pipeline_tenant_idx
  ON nbfc_recovery_pipeline (tenant_id);
CREATE INDEX IF NOT EXISTS nbfc_recovery_pipeline_stage_idx
  ON nbfc_recovery_pipeline (stage);
CREATE INDEX IF NOT EXISTS nbfc_recovery_pipeline_tenant_stage_idx
  ON nbfc_recovery_pipeline (tenant_id, stage);

-- E-038 — auction lots
CREATE TABLE IF NOT EXISTS auction_lots (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_code      varchar(32)  NOT NULL,
  capacity      varchar(32),
  avg_soh       numeric(5,2),
  age_months    integer,
  quantity      integer      NOT NULL,
  base_price    numeric(12,2) NOT NULL,
  bid_increment numeric(12,2) NOT NULL,
  ends_at       timestamptz  NOT NULL,
  status        varchar(16)  NOT NULL DEFAULT 'live',
  created_at    timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT auction_lots_lot_code_key UNIQUE (lot_code)
);
CREATE INDEX IF NOT EXISTS auction_lots_status_idx  ON auction_lots (status);
CREATE INDEX IF NOT EXISTS auction_lots_ends_at_idx ON auction_lots (ends_at);

-- E-038 — auction bids (append-only)
CREATE TABLE IF NOT EXISTS auction_bids (
  id        uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id    uuid          NOT NULL,
  tenant_id uuid          NOT NULL,
  amount    numeric(12,2) NOT NULL,
  placed_at timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auction_bids_lot_idx       ON auction_bids (lot_id);
CREATE INDEX IF NOT EXISTS auction_bids_tenant_idx    ON auction_bids (tenant_id);
CREATE INDEX IF NOT EXISTS auction_bids_placed_at_idx ON auction_bids (placed_at);

-- E-039 — post-auction settlements
CREATE TABLE IF NOT EXISTS auction_settlements (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id           uuid          NOT NULL,
  seller_tenant_id uuid          NOT NULL,
  winner_tenant_id uuid          NOT NULL,
  final_price      numeric(12,2) NOT NULL,
  status           varchar(24)   NOT NULL DEFAULT 'payment_pending',
  created_at       timestamptz   NOT NULL DEFAULT now(),
  updated_at       timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT auction_settlements_lot_id_key UNIQUE (lot_id)
);
CREATE INDEX IF NOT EXISTS auction_settlements_lot_idx
  ON auction_settlements (lot_id);
CREATE INDEX IF NOT EXISTS auction_settlements_seller_tenant_idx
  ON auction_settlements (seller_tenant_id);
CREATE INDEX IF NOT EXISTS auction_settlements_winner_tenant_idx
  ON auction_settlements (winner_tenant_id);
CREATE INDEX IF NOT EXISTS auction_settlements_status_idx
  ON auction_settlements (status);

-- E-069 — Auction Control Centre per-lot action audit trail
CREATE TABLE IF NOT EXISTS nbfc_auction_lot_actions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id         uuid        NOT NULL,
  action_code    varchar(48) NOT NULL,
  previous_value jsonb,
  new_value      jsonb,
  reason         text,
  acted_by       uuid        NOT NULL,
  acted_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nbfc_auction_lot_actions_lot_acted_at_idx
  ON nbfc_auction_lot_actions (lot_id, acted_at);
CREATE INDEX IF NOT EXISTS nbfc_auction_lot_actions_action_code_idx
  ON nbfc_auction_lot_actions (action_code);

-- E-070 — dual-approval lot cancellation ledger
CREATE TABLE IF NOT EXISTS nbfc_auction_cancel_requests (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id       uuid        NOT NULL,
  reason       text        NOT NULL,
  requested_by uuid        NOT NULL,
  approved_by  uuid,
  status       varchar(32) NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  applied_at   timestamptz
);
CREATE INDEX IF NOT EXISTS nbfc_auction_cancel_requests_status_idx
  ON nbfc_auction_cancel_requests (status);
CREATE INDEX IF NOT EXISTS nbfc_auction_cancel_requests_lot_idx
  ON nbfc_auction_cancel_requests (lot_id);
CREATE INDEX IF NOT EXISTS nbfc_auction_cancel_requests_requested_by_idx
  ON nbfc_auction_cancel_requests (requested_by);

-- ============================================================================
-- PART 2 — recovery_batteries (the battery master)
-- ============================================================================

CREATE TABLE IF NOT EXISTS recovery_batteries (
  id                   uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid         NOT NULL,
  serial               varchar(64)  NOT NULL,
  model                varchar(120),
  capacity             varchar(32),
  manufacturing_date   date,
  condition_grade      varchar(24),
  recovery_date        timestamptz,
  warehouse            varchar(160),
  lat                  numeric(10,7),
  lng                  numeric(10,7),
  city                 varchar(120),
  state                varchar(120),
  -- varchar(255), NOT uuid. `loan_sanctions.id` is character varying(255) in
  -- this schema (ids look like application-issued strings, not uuids), and a
  -- uuid column here would reject every real value with 22P02 the first time
  -- anybody linked a battery to the loan it came off.
  loan_sanction_id     varchar(255),
  recovery_pipeline_id uuid,
  -- Relative /api/files/<bucket>/<key> strings, NEVER absolute URLs — the
  -- storage backend flips between Supabase and S3 behind STORAGE_BACKEND and
  -- the proxy route is the only stable address. Captured ONCE at inspection
  -- and reused verbatim as the auction images (BRD §20); nothing re-uploads.
  image_urls           text[]       NOT NULL DEFAULT '{}',
  state_code           varchar(24)  NOT NULL DEFAULT 'draft',
  notes                text,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now(),
  -- One physical battery, one row. The serial is the identity a warehouse
  -- operator actually reads off the casing, so uniqueness is global and not
  -- per-tenant: the same battery must not exist twice because it changed hands.
  CONSTRAINT recovery_batteries_serial_key UNIQUE (serial)
);
CREATE INDEX IF NOT EXISTS recovery_batteries_tenant_idx
  ON recovery_batteries (tenant_id);
CREATE INDEX IF NOT EXISTS recovery_batteries_state_idx
  ON recovery_batteries (state_code);
CREATE INDEX IF NOT EXISTS recovery_batteries_pipeline_idx
  ON recovery_batteries (recovery_pipeline_id);
CREATE INDEX IF NOT EXISTS recovery_batteries_loan_idx
  ON recovery_batteries (loan_sanction_id);

COMMENT ON TABLE recovery_batteries IS
  'E-232: the battery master (BRD §3). One row per PHYSICAL battery, outliving '
  'any single nbfc_recovery_pipeline row — a battery can be recovered, '
  'refurbished, auctioned, refinanced and recovered again.';

COMMENT ON COLUMN recovery_batteries.state_code IS
  'E-232: draft | intaken | inspected | refurbishing | ready | lotted | sold | '
  'scrapped. Named state_code, not state, because `state` is the geographic '
  'column on this same row. No CHECK — vocabulary is enforced in '
  'src/lib/nbfc/recovery/, per this family''s convention.';

COMMENT ON COLUMN recovery_batteries.image_urls IS
  'E-232: relative /api/files/<bucket>/<key> paths. Front, back, side, serial '
  'and damage shots per BRD §20, captured once at inspection and reused as the '
  'auction images.';

-- ============================================================================
-- PART 3 — additive columns: the bidder re-point
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A NOTE ON THE DEALER ID TYPE, because it is not the obvious one.
--
-- `bidder_dealer_id` is varchar(255), NOT uuid. Dealers live in `accounts`,
-- whose primary key is character varying(255) holding application-issued
-- strings like 'ACC-ITARANG-20260409-971' — measured on database-1: 62 rows,
-- ZERO of them uuid-shaped. `users.dealer_id`, the column that points at the
-- same thing, is likewise character varying.
--
-- The first draft of this file used uuid, matching every other id in the
-- auction family. It would have applied cleanly, verified cleanly, and then
-- rejected every real dealer with `22P02 invalid input syntax for type uuid`
-- at the first bid — long after the migration looked done. The self-correcting
-- block below exists because that draft WAS applied to sandbox before the
-- mismatch was caught.
-- ---------------------------------------------------------------------------

ALTER TABLE auction_bids
  ADD COLUMN IF NOT EXISTS bidder_dealer_id varchar(255),
  ADD COLUMN IF NOT EXISTS bidder_kind      varchar(16) NOT NULL DEFAULT 'nbfc';

CREATE INDEX IF NOT EXISTS auction_bids_bidder_dealer_idx
  ON auction_bids (bidder_dealer_id);

COMMENT ON COLUMN auction_bids.bidder_dealer_id IS
  'E-232: accounts.id of the bidding DEALER (BRD §9 — dealers only, never other '
  'NBFCs). Added ALONGSIDE tenant_id, not instead of it: tenant_id is NOT NULL '
  'and still carries the SELLER''s tenant on a dealer bid, which is what keeps '
  'the nbfc_audit_log row for the bid in the right tenant''s log.';

COMMENT ON COLUMN auction_bids.bidder_kind IS
  'E-232: ''dealer'' | ''nbfc''. Says which identity column is authoritative, so '
  'no reader has to infer it from NULLness — a dealer bid populates BOTH '
  'bidder_dealer_id and tenant_id. Existing rows default to ''nbfc'', which is '
  'exactly what they are.';

ALTER TABLE auction_lots
  ADD COLUMN IF NOT EXISTS seller_tenant_id   uuid,
  ADD COLUMN IF NOT EXISTS auction_type       varchar(24) NOT NULL DEFAULT 'cash',
  ADD COLUMN IF NOT EXISTS starts_at          timestamptz,
  ADD COLUMN IF NOT EXISTS anti_snipe_seconds integer     NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS reserve_price      numeric(12,2),
  ADD COLUMN IF NOT EXISTS title              varchar(160),
  ADD COLUMN IF NOT EXISTS published_at       timestamptz;

CREATE INDEX IF NOT EXISTS auction_lots_seller_tenant_idx
  ON auction_lots (seller_tenant_id);
-- The scheduler's two hot queries: "which scheduled lots are due to open" and
-- "which live lots are due to close". Partial, because draft/ended/cancelled
-- lots accumulate forever and the ticker never looks at them.
CREATE INDEX IF NOT EXISTS auction_lots_open_due_idx
  ON auction_lots (starts_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS auction_lots_close_due_idx
  ON auction_lots (ends_at)   WHERE status = 'live';

COMMENT ON COLUMN auction_lots.seller_tenant_id IS
  'E-232: the NBFC that owns the asset and the lot. Its absence is why '
  'approveWinningBid() wrote a zero-UUID sentinel into '
  'auction_settlements.seller_tenant_id, making every settlement it created '
  'invisible to listSettlements() (which filters seller_tenant_id = caller). '
  'Nullable because pre-E-232 lots genuinely have no known seller.';

COMMENT ON COLUMN auction_lots.auction_type IS
  'E-232: ''cash'' | ''cash_refinance'' (BRD §13). cash_refinance routes the '
  'winning dealer into loan origination instead of a one-shot payment.';

COMMENT ON COLUMN auction_lots.starts_at IS
  'E-232: when the scheduler flips ''scheduled'' -> ''live''. NULL on legacy lots, '
  'which were auto-published live on creation with no scheduled start.';

COMMENT ON COLUMN auction_lots.anti_snipe_seconds IS
  'E-232: a bid inside this window of ends_at pushes ends_at out by the same '
  'amount (BRD §11). Default 120s. Without it a 2-hour auction is decided in '
  'its final second.';

COMMENT ON COLUMN auction_lots.reserve_price IS
  'E-232: the real reserve. setReservePrice() currently overwrites base_price '
  'and calls it "the canonical reserve price", which destroys the starting '
  'price the lot was published at. New code writes here; base_price goes back '
  'to meaning what it says.';

COMMENT ON COLUMN auction_lots.status IS
  'E-232: draft | scheduled | live | paused | ended | cancelled. draft and '
  'scheduled are new — a lot is no longer published the instant a battery '
  'reaches ready_for_auction (BRD §7). No CHECK constraint, per this family''s '
  'convention; the vocabulary is enforced in src/lib/nbfc/auction/.';

ALTER TABLE auction_settlements
  ADD COLUMN IF NOT EXISTS winner_dealer_id varchar(255);

CREATE INDEX IF NOT EXISTS auction_settlements_winner_dealer_idx
  ON auction_settlements (winner_dealer_id);

COMMENT ON COLUMN auction_settlements.winner_dealer_id IS
  'E-232: accounts.id of the winning DEALER, mirroring '
  'auction_bids.bidder_dealer_id. winner_tenant_id stays NOT NULL and carries '
  'the seller''s tenant on a dealer win. payment_ref and refinance_loan_id are '
  'deliberately NOT added here — they belong to Phase 6, which is out of scope.';

ALTER TABLE nbfc_recovery_pipeline
  ADD COLUMN IF NOT EXISTS battery_id uuid;

CREATE INDEX IF NOT EXISTS nbfc_recovery_pipeline_battery_idx
  ON nbfc_recovery_pipeline (battery_id);

COMMENT ON COLUMN nbfc_recovery_pipeline.battery_id IS
  'E-232: recovery_batteries.id. The real key that replaces the string join in '
  'settlements.ts, which matched nbfc_recovery_pipeline.battery_serial against '
  'auction_lots.lot_code — two values that are never equal, so marking a '
  'battery ''resold'' has never once worked.';

-- ============================================================================
-- PART 4 — self-correction for the uuid draft of this file
-- ============================================================================
--   An earlier version of PART 2/3 declared the three dealer/loan reference
--   columns as `uuid`, matching the rest of the auction family. That is wrong:
--   `accounts.id` and `loan_sanctions.id` are both character varying(255)
--   holding application-issued strings, so those columns would have accepted
--   the migration and then rejected every real value with 22P02 at the first
--   dealer bid.
--
--   That draft reached database-1 before the mismatch was found, so correcting
--   the CREATE/ADD statements alone would leave the already-applied database
--   permanently wrong while reporting success. These blocks bring such a
--   database into line and are a no-op everywhere else.
--
--   Safe as written: all three columns are 100% NULL on every database that has
--   them (they were added by this same file and nothing has written to them
--   yet), so the USING clause has no rows to convert and cannot lose data. The
--   guard means this is not a repeated ALTER on every re-run either.
--
--   This is a type WIDENING on empty columns, not the destructive change
--   CLAUDE.md's additive-only rule is about. It is called out here rather than
--   left to be noticed.

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'auction_bids'
       AND column_name = 'bidder_dealer_id' AND data_type = 'uuid'
  ) THEN
    ALTER TABLE auction_bids
      ALTER COLUMN bidder_dealer_id TYPE varchar(255)
      USING bidder_dealer_id::text;
    RAISE NOTICE 'E-232: corrected auction_bids.bidder_dealer_id uuid -> varchar(255)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'auction_settlements'
       AND column_name = 'winner_dealer_id' AND data_type = 'uuid'
  ) THEN
    ALTER TABLE auction_settlements
      ALTER COLUMN winner_dealer_id TYPE varchar(255)
      USING winner_dealer_id::text;
    RAISE NOTICE 'E-232: corrected auction_settlements.winner_dealer_id uuid -> varchar(255)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'recovery_batteries'
       AND column_name = 'loan_sanction_id' AND data_type = 'uuid'
  ) THEN
    ALTER TABLE recovery_batteries
      ALTER COLUMN loan_sanction_id TYPE varchar(255)
      USING loan_sanction_id::text;
    RAISE NOTICE 'E-232: corrected recovery_batteries.loan_sanction_id uuid -> varchar(255)';
  END IF;
END $do$;

COMMIT;
