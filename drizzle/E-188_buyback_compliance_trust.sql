------------------------------------------------------------------------------
-- E-188: peakAmp Battery Buyback — compliance, trust & catalog (Sprints 3–4).
--
-- Sprints 0–2 built the deal: intake → negotiation → margin → vendor → PO →
-- pickup → invoice → settlement → CLOSED. This file adds what makes it
-- TRUSTWORTHY rather than merely functional:
--
--   M03  photo dedup — the same battery cannot be sold to us twice
--   M05  BWM 2022 pickup compliance — variance must be acknowledged before payout
--   M16  versioned price books — a catalog edit cannot move an open request
--   M13  bank-statement reconciliation (STATEMENT method)
--   M19  agreements — Digio eSign for dealers AND vendors, gating the role
--
-- Spec: docs/peakAmp/DEVELOPMENT_BRD.md §3, M03/M05/M13/M16/M17–M19.
--
-- THREE INVARIANTS ENFORCED HERE, IN THE SCHEMA:
--
--   · A duplicate photo hash ACROSS DEALERS is the fraud case (M03 AC) — the
--     same battery photographed and sold twice. buyback_photos.phash is indexed
--     so the nightly sweep is a lookup, not a table scan, and the flag columns
--     make an unresolved duplicate visible rather than merely logged.
--
--   · A STATEMENT settlement bypasses the MANUAL proof CHECK legitimately — the
--     bank statement IS the evidence. E-187's constraint already reads
--     `method <> 'MANUAL' OR (proof IS NOT NULL AND ref IS NOT NULL)`, so a
--     STATEMENT row is permitted without an uploaded proof file. But it must be
--     traceable to the imported row, hence statement_row_id below.
--
--   · An agreement is per (entity, role). business_entity_roles.agreement_id
--     already exists (E-185) and now points here. A vendor with no ACTIVE role
--     is unselectable for routing — which is how M18's AC becomes true when
--     Sprint 4 makes ACTIVE mean "signed", with no change to the routing query.
--
-- Additive + idempotent. Re-running this file is a no-op.
------------------------------------------------------------------------------

------------------------------------------------------------------------------
-- 1. ENUM TYPES
------------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_agreement_status') THEN
    CREATE TYPE buyback_agreement_status AS ENUM ('DRAFT', 'SENT', 'SIGNED', 'DECLINED', 'EXPIRED');
  END IF;

  -- A statement row is UNMATCHED until someone (or the matcher) ties it to an
  -- expected settlement. IGNORED is for the rows that are not ours at all —
  -- salaries, rent, everything else on a real bank statement.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_stmt_row_status') THEN
    CREATE TYPE buyback_stmt_row_status AS ENUM ('UNMATCHED', 'SUGGESTED', 'MATCHED', 'IGNORED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_photo_flag') THEN
    CREATE TYPE buyback_photo_flag AS ENUM ('DUPLICATE_SAME_DEALER', 'DUPLICATE_CROSS_DEALER');
  END IF;
END $$;

------------------------------------------------------------------------------
-- 2. AGREEMENTS (M19 / U12)
--
--    Digio eSign, for dealers AND vendors. business_entity_roles.agreement_id
--    (E-185) points at these; the signed webhook flips the ROLE to ACTIVE, which
--    is what actually unlocks anything.
--
--    U12: an existing dealer of the same firm does NOT redo KYC. They confirm the
--    firm registration number and sign the buyback agreement — nothing more. That
--    is why firm_registration_no lives here, on the agreement, and not on a new
--    onboarding table: there IS no second onboarding.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agreements (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            VARCHAR(255) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role                 buyback_entity_role NOT NULL,
  digio_doc_id         TEXT,
  firm_registration_no TEXT,
  status               buyback_agreement_status NOT NULL DEFAULT 'DRAFT',
  pdf_s3               TEXT,
  signed_pdf_s3        TEXT,
  sent_at              TIMESTAMPTZ,
  signed_at            TIMESTAMPTZ,
  declined_reason      TEXT,
  created_by           UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One LIVE agreement per (entity, role). A declined or expired one is kept — the
-- history of who refused to sign what is exactly the sort of thing you want six
-- months later.
CREATE UNIQUE INDEX IF NOT EXISTS agreements_one_live_per_entity_role
  ON agreements (entity_id, role)
  WHERE status IN ('DRAFT', 'SENT', 'SIGNED');

CREATE INDEX IF NOT EXISTS agreements_digio_doc_idx ON agreements (digio_doc_id);

------------------------------------------------------------------------------
-- 3. PHOTO DEDUP (M03)
--
--    AC: "duplicate phash across dealers raises a flag."
--
--    That is the fraud case, and it is worth being explicit about why: the same
--    battery, photographed once, sold to us by two different dealers. A duplicate
--    WITHIN one dealer's own request is usually just a careless re-upload; a
--    duplicate ACROSS dealers means somebody is selling something twice. The two
--    are flagged separately because they warrant completely different responses.
--
--    phash is already a column (E-185). It was never populated because Sprint 1
--    deliberately left hashing to Sprint 3. Now it is indexed.
------------------------------------------------------------------------------
ALTER TABLE buyback_photos
  ADD COLUMN IF NOT EXISTS phash_computed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dup_of_photo_id   UUID REFERENCES buyback_photos(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dup_flag          buyback_photo_flag,
  ADD COLUMN IF NOT EXISTS dup_flagged_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dup_cleared_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dup_cleared_by    UUID;

-- The nightly sweep matches on this. Without the index it is a full scan of every
-- photo ever uploaded, every night.
CREATE INDEX IF NOT EXISTS buyback_photos_phash_idx
  ON buyback_photos (phash) WHERE phash IS NOT NULL;

-- Un-hashed photos, oldest first — the sweep's work queue.
CREATE INDEX IF NOT EXISTS buyback_photos_unhashed_idx
  ON buyback_photos (created_at) WHERE phash IS NULL;

-- Open flags, for the admin queue.
CREATE INDEX IF NOT EXISTS buyback_photos_flagged_idx
  ON buyback_photos (dup_flagged_at) WHERE dup_flag IS NOT NULL AND dup_cleared_at IS NULL;

------------------------------------------------------------------------------
-- 4. PRICE BOOKS (M16)
--
--    AC (the load-bearing one): "catalog edits never change open requests'
--    reference price."
--
--    That already holds — buyback_lines.price_book_version_at_create snapshots
--    the version when the line is created, and every read of an open request uses
--    the line's own expected_price_per_unit, not the catalog's current one. What
--    was missing is the HISTORY: without it, "the price at version 3" is an
--    unanswerable question, and an auditor asking why a six-month-old request
--    quoted ₹5,200 has nowhere to look.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS catalog_price_history (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id                UUID NOT NULL REFERENCES catalog_variants(id) ON DELETE CASCADE,
  price_book_version        INTEGER NOT NULL,
  unit_price                NUMERIC(12,2),
  est_buyback_price_working NUMERIC(12,2),
  est_buyback_price_dead    NUMERIC(12,2),
  changed_by                UUID,
  note                      TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_price_history_variant_version_unique
  ON catalog_price_history (variant_id, price_book_version);

-- When the business last looked at prices. M16 wants a weekly nudge; without a
-- recorded review date, "weekly" is unenforceable.
CREATE TABLE IF NOT EXISTS catalog_price_reviews (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewed_by UUID,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

------------------------------------------------------------------------------
-- 5. BANK STATEMENT RECONCILIATION (M13, the STATEMENT method / U9)
--
--    An admin uploads the bank statement; rows are parsed, matched against the
--    settlements we EXPECT, and confirmed. A matched row becomes a settlement
--    with method='STATEMENT' — and that legitimately carries no uploaded proof
--    file, because the statement IS the proof. E-187's CHECK only demands a proof
--    file for MANUAL, precisely so this path stays honest rather than needing a
--    fake proof to satisfy a constraint.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bank_statement_imports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename      TEXT NOT NULL,
  s3_key        TEXT,
  account_label TEXT,               -- which bank account this statement is for
  row_count     INTEGER NOT NULL DEFAULT 0,
  matched_count INTEGER NOT NULL DEFAULT 0,
  imported_by   UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_statement_rows (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id      UUID NOT NULL REFERENCES bank_statement_imports(id) ON DELETE CASCADE,
  txn_date       DATE NOT NULL,
  -- Signed: credits positive, debits negative. Storing the sign rather than a
  -- separate direction column means a row cannot claim to be a credit while
  -- carrying a debit's amount.
  amount         NUMERIC(14,2) NOT NULL,
  txn_ref        TEXT,             -- UTR / cheque no. — what we match on
  description    TEXT,
  status         buyback_stmt_row_status NOT NULL DEFAULT 'UNMATCHED',
  -- What the matcher THINKS this row is. Not applied until a human confirms.
  suggested_deal_id UUID REFERENCES buyback_deals(id) ON DELETE SET NULL,
  suggested_leg     buyback_leg,
  matched_settlement_id UUID REFERENCES settlement_transactions(id) ON DELETE SET NULL,
  matched_by     UUID,
  matched_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bank_statement_rows_import_idx ON bank_statement_rows (import_id);
CREATE INDEX IF NOT EXISTS bank_statement_rows_ref_idx ON bank_statement_rows (txn_ref);
-- The unmatched queue.
CREATE INDEX IF NOT EXISTS bank_statement_rows_open_idx
  ON bank_statement_rows (txn_date) WHERE status IN ('UNMATCHED', 'SUGGESTED');

-- Trace a STATEMENT settlement back to the statement row that evidenced it.
ALTER TABLE settlement_transactions
  ADD COLUMN IF NOT EXISTS statement_row_id UUID REFERENCES bank_statement_rows(id) ON DELETE SET NULL;

------------------------------------------------------------------------------
-- 6. PICKUP VARIANCE ACKNOWLEDGEMENT (M05)
--
--    AC: "dealer WhatsApp ack on variance BEFORE payout."
--
--    The BWM columns already exist (E-186). What was missing is the GATE: nothing
--    stopped a payout while a variance sat unacknowledged. `variance_ack_required`
--    makes the obligation explicit rather than inferring it from
--    `variance_flag AND dealer_ack_at IS NULL` scattered across the code — and the
--    settlement route refuses to record a dealer payout while it is unmet.
--
--    Why this matters: a variance means we counted fewer (or fewer working)
--    batteries than the dealer invoiced for. Paying out before they agree to the
--    count means arguing about money we have already sent.
------------------------------------------------------------------------------
ALTER TABLE pickups
  ADD COLUMN IF NOT EXISTS expected_counts        JSONB,
  ADD COLUMN IF NOT EXISTS variance_ack_required  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS variance_note          TEXT,
  ADD COLUMN IF NOT EXISTS eway_bill_s3           TEXT;

------------------------------------------------------------------------------
-- 7. COMMENTS
------------------------------------------------------------------------------
COMMENT ON TABLE agreements IS
  'E-188 — Digio eSign for dealers AND vendors (M19/U12). The signed webhook flips business_entity_roles.status to ACTIVE, which is what actually unlocks anything: an entity with no ACTIVE role cannot trade. An existing dealer of the same firm does NOT redo KYC — they confirm firm_registration_no and sign, which is why that column lives here and there is no second onboarding table.';

COMMENT ON COLUMN buyback_photos.dup_flag IS
  'E-188 — DUPLICATE_CROSS_DEALER is the fraud case (M03 AC): the same battery photographed once and sold to us by two different dealers. DUPLICATE_SAME_DEALER is usually just a careless re-upload. They are flagged separately because they warrant completely different responses.';

COMMENT ON TABLE bank_statement_rows IS
  'E-188 — M13/U9 STATEMENT reconciliation. A matched row becomes a settlement with method=STATEMENT, which legitimately carries no uploaded proof FILE: the bank statement IS the proof. E-187''s CHECK demands a proof file only for MANUAL, precisely so this path does not have to fake one to satisfy a constraint. `amount` is signed (credits positive) so a row cannot claim to be a credit while carrying a debit''s amount.';

COMMENT ON COLUMN pickups.variance_ack_required IS
  'E-188 — M05 AC: the dealer must acknowledge a count variance BEFORE payout. Making the obligation an explicit column (rather than inferring it from variance_flag AND dealer_ack_at IS NULL in several places) is what lets the settlement route refuse a dealer payout while it is unmet. Paying out before the dealer agrees to the count means arguing about money already sent.';

COMMENT ON TABLE catalog_price_history IS
  'E-188 — M16. The AC ("catalog edits never change open requests'' reference price") already holds via buyback_lines.price_book_version_at_create. This table answers the question that snapshot alone cannot: what WAS the price at version 3? Without it, an auditor asking why a six-month-old request quoted ₹5,200 has nowhere to look.';
