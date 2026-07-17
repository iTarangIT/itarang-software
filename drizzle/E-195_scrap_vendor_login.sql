------------------------------------------------------------------------------
-- E-195: scrap vendor login — users.vendor_entity_id.
--
-- BRD M24 deferred the vendor login, and everything downstream has been paying
-- for it since. With no `vendor` actor, a vendor's counter or agreement could
-- only reach the system as an ADMIN RECORDING IT off an email — which is why
-- admin and vendor actions ended up on the same screen, and why "the buyer
-- raises the Purchase Order" was unmodellable: on the vendor leg the buyer IS
-- the vendor, and there was no vendor to raise it.
--
-- A vendor is already an `accounts` row + `business_entity_roles(role =
-- 'SCRAP_VENDOR')` + `scrap_vendors` (E-186). The only thing missing was a way
-- for a `users` row to say WHICH vendor it is.
--
-- WHY NOT REUSE users.dealer_id:
--   It would actually hold the right value — accounts.id and dealer_code are
--   the same string, and users.dealer_id already stores it. But it is joined
--   against the `dealers` table by dealer_code all over the app, and a scrap
--   vendor has no `dealers` row. Every one of those joins would quietly return
--   nothing for a vendor rather than fail loudly, which is the worst outcome:
--   a dealer-shaped query silently answering for a non-dealer. A separate
--   column makes the two populations impossible to confuse, and makes
--   `WHERE vendor_entity_id IS NOT NULL` a truthful census of vendor logins.
--
-- NO ROLE ENUM TO EXTEND: users.role is a bare varchar(50) with no constraint,
-- so 'scrap_vendor' needs no DDL at all. It is registered in six hardcoded
-- TypeScript lists instead (middleware roleDashboards, sidebar roleNavigation,
-- sidebar inferredRole, the two login redirect chains, lib/roles.ts) — and
-- missing one fails silently, which is a hazard worth writing down here where
-- the next person adding a role will look.
--
-- Applies EVERYWHERE, including production: `users` and `accounts` exist on
-- every environment, unlike the buyback tables. It is guarded anyway, because
-- a migration that assumes is a migration that surprises someone.
--
-- Additive + idempotent. Re-running this file is a no-op.
------------------------------------------------------------------------------

DO $do$ BEGIN
  ALTER TABLE users ADD COLUMN IF NOT EXISTS vendor_entity_id varchar(255);

  -- FK to accounts, mirroring scrap_vendors.entity_id. NOT ON DELETE CASCADE:
  -- deleting an account must not silently delete the login rows attached to it
  -- — that is a decision a human makes, not a side effect of tidying up.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_vendor_entity_id_fkey'
  ) THEN
    BEGIN
      ALTER TABLE users
        ADD CONSTRAINT users_vendor_entity_id_fkey
        FOREIGN KEY (vendor_entity_id) REFERENCES accounts(id);
    EXCEPTION WHEN undefined_table THEN
      RAISE NOTICE 'accounts does not exist here — users.vendor_entity_id added without its FK';
    END;
  END IF;

  CREATE INDEX IF NOT EXISTS users_vendor_entity_id_idx
    ON users (vendor_entity_id)
    WHERE vendor_entity_id IS NOT NULL;

  COMMENT ON COLUMN users.vendor_entity_id IS
    'E-195 — accounts.id of the scrap vendor this login acts for; NULL for every non-vendor user. Deliberately NOT users.dealer_id: that column is joined against the dealers table by dealer_code app-wide, and a scrap vendor has no dealers row, so those joins would silently return nothing instead of failing. Pairs with role = ''scrap_vendor'' (users.role is an unconstrained varchar — no enum to extend).';
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'users does not exist here — skipping E-195';
END; $do$;
