------------------------------------------------------------------------------
-- E-197: who the previous owner is, and how to pay them.
--
-- Item 4: "PAN, Aadhaar, bank account details, ID proof upload — payment may
-- need to go directly to the driver/battery owner, not only to the dealer."
--
-- THE FINDING THAT SHAPED THIS: until now that was unbuildable. `buyback_leg`
-- has exactly two values (DEALER, VENDOR) and settlement_transactions.leg uses
-- it, so there was nowhere to record a payment to anybody else. Collecting a
-- driver's bank account would have been pure liability — data we are obliged to
-- protect, for a payment the schema could not express.
--
-- THE MODEL, confirmed with the business: two cases exist.
--
--   1. INSTEAD OF the dealer — the dealer brokered a battery they never owned,
--      so the single OUT payment goes to the driver. THIS IS WHAT E-197 BUILDS.
--      It is not a new leg: it is the SAME payment, of the SAME locked
--      dealer_price, to a different beneficiary. Nothing about the money
--      changes, so nothing about the invariants changes — M14's "ledger net for
--      CLOSED deals == dashboard Total Margin Earned" still holds by
--      construction, because we still pay dealer_price out exactly once.
--
--   2. A SPLIT — driver and dealer both paid for the same battery. DELIBERATELY
--      NOT BUILT. That IS a third leg: an ALTER TYPE on buyback_leg (shared by
--      purchase_orders, invoices and negotiation_rounds, where a DRIVER value is
--      meaningless), a rewrite of "both legs closed => SETTLED", and a
--      re-derivation of M14. It also needs a rule for how the split is decided
--      and who decides it, which nobody has written. Build it when there is
--      volume to justify it; do not let it hold up case 1.
--
-- WHY THE COLUMNS LIVE ON provenance_records: that table already identifies the
-- previous owner (name, phone, vehicle, RC, ID proof) and is already scoped per
-- LINE or per UNIT. The payee is that person. It does mean one request can name
-- several payees — which is exactly right, since a lot can be split across
-- drivers (see the Split action in the intake), and it is why the payout picks a
-- payee rather than assuming one.
--
-- AADHAAR IS MASKED, AND THAT IS NOT NEGOTIABLE. Last four digits plus a
-- Decentro verification reference. Never the raw number, never the image. Under
-- the DPDP Act / UIDAI rules, storing a full Aadhaar makes us the custodian of
-- something we have no need to hold: the last four proves we saw it, and the
-- Decentro reference proves it VERIFIED, which is strictly better evidence than
-- a number we typed in ourselves. The repo already has Decentro wired for KYC
-- (src/lib/kyc/) — reuse it, do not build a second path.
--
-- PAN AND BANK ARE FULL, and the asymmetry is the point:
--   · PAN is a tax identity. TDS and reporting need the real thing, and it is
--     not a credential — it cannot be used to move money.
--   · A bank account cannot be masked. You cannot pay a last-four. If we are
--     going to pay this person, we hold their account; if we are not going to
--     pay them, DO NOT COLLECT IT. That is why these columns land in the same
--     migration as the payee pointer and not before it.
--
-- Additive + idempotent. All nullable: the intake autosaves a provenance record
-- long before any of this is typed, and "required" is the submit gate's job, not
-- NOT NULL's — the same rule E-191 states for the battery spec.
--
-- No-ops with a NOTICE where the buyback tables do not exist (production).
------------------------------------------------------------------------------

-- 1. Who the previous owner is ------------------------------------------------
DO $do$ BEGIN
  ALTER TABLE provenance_records ADD COLUMN IF NOT EXISTS prev_owner_pan            text;
  ALTER TABLE provenance_records ADD COLUMN IF NOT EXISTS prev_owner_aadhaar_last4  varchar(4);
  ALTER TABLE provenance_records ADD COLUMN IF NOT EXISTS prev_owner_aadhaar_ref    text;
  ALTER TABLE provenance_records ADD COLUMN IF NOT EXISTS prev_owner_aadhaar_verified_at timestamptz;

  -- Only ever four digits, and only ever digits. A full Aadhaar cannot fit here
  -- even by accident — the constraint is the compliance control, not the code
  -- that writes it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'provenance_aadhaar_last4_chk'
  ) THEN
    ALTER TABLE provenance_records
      ADD CONSTRAINT provenance_aadhaar_last4_chk
      CHECK (prev_owner_aadhaar_last4 IS NULL OR prev_owner_aadhaar_last4 ~ '^[0-9]{4}$');
  END IF;

  COMMENT ON COLUMN provenance_records.prev_owner_pan IS
    'E-197 — the previous owner''s PAN, in full. A tax identity, needed for TDS/reporting, and not a credential: it cannot move money. Contrast prev_owner_aadhaar_last4, which is masked precisely because it is identity-grade.';
  COMMENT ON COLUMN provenance_records.prev_owner_aadhaar_last4 IS
    'E-197 — LAST FOUR DIGITS ONLY, enforced by provenance_aadhaar_last4_chk. Never the full number and never the image: under DPDP/UIDAI, storing a full Aadhaar makes iTarang custodian of something it has no need to hold. The last four proves we saw it; prev_owner_aadhaar_ref proves Decentro VERIFIED it, which is better evidence than a number we typed ourselves.';
  COMMENT ON COLUMN provenance_records.prev_owner_aadhaar_ref IS
    'E-197 — the Decentro verification reference. THIS, not the number, is the evidence. Reuse src/lib/kyc/ — do not build a second Aadhaar path.';
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'provenance_records does not exist here yet (E-185 not applied) — skipping E-197 part 1';
END; $do$;

-- 2. How to pay them ----------------------------------------------------------
DO $do$ BEGIN
  ALTER TABLE provenance_records ADD COLUMN IF NOT EXISTS payee_account_number   text;
  ALTER TABLE provenance_records ADD COLUMN IF NOT EXISTS payee_ifsc             varchar(11);
  ALTER TABLE provenance_records ADD COLUMN IF NOT EXISTS payee_bank_name        text;
  ALTER TABLE provenance_records ADD COLUMN IF NOT EXISTS payee_beneficiary_name text;

  COMMENT ON COLUMN provenance_records.payee_account_number IS
    'E-197 — the previous owner''s bank account, IN FULL. It cannot be masked: you cannot pay a last-four. Held ONLY because settlement_transactions.payee_provenance_id makes paying this person expressible — if that ever goes away, so should this. Do not collect a bank account for somebody the system cannot pay.';
  COMMENT ON COLUMN provenance_records.payee_beneficiary_name IS
    'E-197 — the name on the account, which is not always prev_owner_name (a driver may bank as their firm). Mirrors accounts.bank_beneficiary_name (E-193), which exists for the same reason on the dealer leg.';
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'provenance_records does not exist here yet — skipping E-197 part 2';
END; $do$;

-- 3. The payee pointer — the whole reason the above is not liability -----------
DO $do$ BEGIN
  ALTER TABLE settlement_transactions
    ADD COLUMN IF NOT EXISTS payee_provenance_id uuid;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'settlement_payee_provenance_fkey'
  ) THEN
    -- NOT ON DELETE CASCADE: a settlement is a financial record. Deleting the
    -- provenance row must never delete the evidence of a payment made against it.
    ALTER TABLE settlement_transactions
      ADD CONSTRAINT settlement_payee_provenance_fkey
      FOREIGN KEY (payee_provenance_id) REFERENCES provenance_records(id);
  END IF;

  -- A payee override only makes sense on the leg we pay OUT. The vendor leg is
  -- money coming IN — there is no beneficiary to redirect.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'settlement_payee_dealer_leg_only_chk'
  ) THEN
    ALTER TABLE settlement_transactions
      ADD CONSTRAINT settlement_payee_dealer_leg_only_chk
      CHECK (payee_provenance_id IS NULL OR leg = 'DEALER');
  END IF;

  COMMENT ON COLUMN settlement_transactions.payee_provenance_id IS
    'E-197 — WHO received this OUT payment, when it was not the dealer. NULL means the dealer, which is every existing row and remains the default. Set means the battery''s previous owner (a driver) was paid directly, because the dealer brokered a battery they never owned. NOT A NEW LEG: same leg, same amount (the locked dealer_price), different beneficiary — which is why M14 still holds, we still pay dealer_price out exactly once. A driver-AND-dealer SPLIT is a genuinely different thing and is not modelled: that needs a third buyback_leg value, a rewrite of both-legs-closed=>SETTLED, and a re-derivation of M14.';
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'settlement_transactions does not exist here yet (E-187 not applied) — skipping E-197 part 3';
END; $do$;
