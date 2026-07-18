------------------------------------------------------------------------------
-- E-194: buyback intake + review queue corrections.
--
-- Four small, unrelated-looking changes that all trace back to one afternoon's
-- evidence on db-1: of the first 32 buyback requests, 24 died in DRAFT and only
-- one of four dealers had ever landed a request in the review queue. Fourteen
-- drafts had no battery lines at all; ten had lines with zero photos against a
-- minimum of five. To an admin the queue looked broken ("it only shows one
-- dealer"); to a dealer the request looked sent. Neither was true.
--
--  1. buyback_pickup_addresses.owner_kind — whose address this is. Until now
--     an address was implicitly the dealer's (entity_id -> accounts), so a
--     vendor's collection point or a driver/customer's doorstep had nowhere to
--     live. Nullable-with-default, so every existing row is a DEALER address,
--     which is what they all in fact are.
--
--  2. buyback_requests (submitted_at DESC NULLS LAST, created_at DESC) — the
--     review queue now sorts newest-first. E-192 added the ASC index for the
--     old sort; a reverse scan of it yields DESC NULLS *FIRST*, which would
--     float every unsubmitted request to the top of the queue, so the DESC
--     sort needs its own index rather than reusing that one. The ASC index is
--     left in place: /reports and any FIFO reader still want it.
--
--  3/4. Two COMMENTs on buyback_lines that E-191 left behind and that are now
--     false — the submit gate no longer demands the IOT brand name, and the
--     functional/non-functional split is a ceiling rather than an equality.
--     A comment that lies is worse than none: it is what the next person reads
--     instead of the code.
--
-- TEXT + CHECK rather than a new enum type for owner_kind, following E-191's
-- reasoning in this same table family: the allowed set is a product decision
-- that may grow (a transporter's yard? a warehouse?), and ALTER TYPE on a
-- shared DB is exactly what these conventions exist to avoid. Validated by zod
-- at the API boundary, same as buyback_lines.chemistry.
--
-- Additive + idempotent. Re-running this file is a no-op. No-ops with a NOTICE
-- where the buyback tables don't exist (i.e. production).
------------------------------------------------------------------------------

-- 1. Address ownership -------------------------------------------------------
DO $do$ BEGIN
  ALTER TABLE buyback_pickup_addresses
    ADD COLUMN IF NOT EXISTS owner_kind text NOT NULL DEFAULT 'DEALER';

  -- Safe to add validated: the column is new and every row carries the
  -- default, so there is nothing pre-existing that could violate it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'buyback_pickup_addresses_owner_kind_chk'
  ) THEN
    ALTER TABLE buyback_pickup_addresses
      ADD CONSTRAINT buyback_pickup_addresses_owner_kind_chk
      CHECK (owner_kind IN ('DEALER', 'VENDOR', 'CUSTOMER'));
  END IF;

  COMMENT ON COLUMN buyback_pickup_addresses.owner_kind IS
    'DEALER | VENDOR | CUSTOMER — whose address this is. DEALER: the dealer''s own shop/warehouse (the only kind before E-194). VENDOR: a recycler''s collection point. CUSTOMER: a driver/previous owner''s doorstep, where the battery is collected from the person being paid. entity_id still says WHICH account it hangs off; this says what role that account is playing.';
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'buyback_pickup_addresses does not exist here yet (E-185 not applied) — skipping E-194 part 1';
END; $do$;

-- 2. Newest-first review queue ------------------------------------------------
DO $do$ BEGIN
  CREATE INDEX IF NOT EXISTS buyback_requests_submitted_created_desc_idx
    ON buyback_requests (submitted_at DESC NULLS LAST, created_at DESC);

  COMMENT ON INDEX buyback_requests_submitted_created_desc_idx IS
    'E-194 — backs the review queue''s newest-first sort (src/app/api/admin/buyback/queue/route.ts). Distinct from E-192''s ASC index: reverse-scanning that one gives DESC NULLS FIRST, which puts unsubmitted requests on top.';
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'buyback_requests does not exist here yet (E-185 not applied) — skipping E-194 part 2';
END; $do$;

-- 3/4. Correct two E-191 comments the gate has since outgrown ----------------
DO $do$ BEGIN
  COMMENT ON COLUMN buyback_lines.functional_qty IS
    'Dealer-declared split of `quantity`. E-194: the submit gate checks functional + non_functional <= quantity, NOT = quantity. It demanded equality until then, which rejected the ordinary case of a partially tested lot — 5 working + 3 dead out of 10, with 2 untested, is a truthful declaration. The remainder is simply unclassified.';

  COMMENT ON COLUMN buyback_lines.iot_brand_name IS
    'Only meaningful when iot_battery is true. E-194: NO LONGER REQUIRED by the submit gate — a dealer reselling a second-hand pack often cannot know who made the IOT module, so requiring it bought guesses rather than facts. NULL means the dealer did not answer, and STAYS null: the ''Intellicar'' assumption is applied on READ by resolveIotBrand() in src/lib/buyback/line-spec.ts, never written here. Writing it would erase the only thing separating an assumption from an answer — a dealer who knows it is an Intellicar and types it must not become indistinguishable from one who never looked.';
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'buyback_lines does not exist here yet (E-185 not applied) — skipping E-194 parts 3/4';
END; $do$;
