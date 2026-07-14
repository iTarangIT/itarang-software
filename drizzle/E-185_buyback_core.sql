  ------------------------------------------------------------------------------
  -- E-185: peakAmp Battery Buyback Portal — core schema (Sprint 0).
  --
  -- iTarang is a back-to-back principal trader in end-of-life batteries: buy from
  -- dealers (dealer leg), sell to scrap vendors (vendor leg), margin locked at
  -- agreement. This lays down the tables the deal state machine runs on.
  -- Spec: docs/peakAmp/DEVELOPMENT_BRD.md §3.
  --
  -- Sprint 1 only exercises the dealer leg (submit → info loop → per-SKU
  -- negotiation → versioned final offer → accepted → margin locked). The vendor
  -- leg, POs, invoices, settlements and pickups land in Sprint 2+ and are NOT in
  -- this file. The status ENUM, however, declares ALL states up front so no later
  -- sprint ever needs an ALTER TYPE.
  --
  -- Four BRD invariants are enforced here, in the schema, not in app code:
  --   1. Pricing NEVER lives on the request — buyback_requests has no price column.
  --      Prices live on lines, offers and locks; totals are always derived.
  --   2. Every offer/counter/final offer is itemized per SKU — negotiation_rounds
  --      and final_offers carry NO amount column; amounts exist only on their
  --      *_lines children. A lump-sum counter is not representable.
  --   5. buyback_activity_log is INSERT-only — enforced by a BEFORE UPDATE/DELETE
  --      trigger, which binds even the table owner (a REVOKE would not).
  --   6. Exactly one notification event per state change — idempotency_key UNIQUE.
  --
  -- Naming note: three BRD §3 names are prefixed here because the bare name is
  -- taken or too generic in this 209-table schema — `notifications` (already an
  -- in-app per-user bell table), `photos`, `activity_log` (`audit_logs` exists).
  -- Unrelated to nbfc_buyback_requests (E-118), which is NBFC recovery of
  -- financed batteries — a different domain that happens to share the word.
  --
  -- Additive + idempotent. Re-running this file is a no-op.
  ------------------------------------------------------------------------------

  ------------------------------------------------------------------------------
  -- 1. ENUM TYPES
  ------------------------------------------------------------------------------
  DO $$ BEGIN
    -- The deal state machine (BRD §2). ALL states declared now — Sprint 1 only
    -- transitions into the first eight; the rest are reachable in Sprint 2+.
    -- DEALER_REOPENED is declared but intentionally unreachable: `reopen` returns
    -- the deal to NEGOTIATING and bumps offer_version, which already carries the
    -- "this is a reopen" signal. Declared so splitting it out later needs no DDL.
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_deal_status') THEN
      CREATE TYPE buyback_deal_status AS ENUM (
        'DRAFT', 'SUBMITTED', 'UNDER_REVIEW',
        'INFO_REQUESTED', 'NEGOTIATING', 'FINAL_OFFER_SENT',
        'DEALER_ACCEPTED', 'MARGIN_SET',
        'VENDOR_ROUTED', 'VENDOR_NEGOTIATING', 'VENDOR_AGREED', 'DEALER_REOPENED',
        'PO_EXCHANGED', 'PICKUP_SCHEDULED', 'PICKED_UP',
        'INVOICE_RAISED', 'INVOICE_APPROVED', 'SETTLED', 'CLOSED',
        'REJECTED', 'CANCELLED'
      );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_entity_role') THEN
      CREATE TYPE buyback_entity_role AS ENUM ('BATTERY_DEALER', 'SCRAP_SELLER', 'SCRAP_VENDOR');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_source_channel') THEN
      CREATE TYPE buyback_source_channel AS ENUM ('WEB', 'WHATSAPP', 'CSV');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_condition') THEN
      CREATE TYPE buyback_condition AS ENUM ('WORKING', 'DEAD');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_prov_scope') THEN
      CREATE TYPE buyback_prov_scope AS ENUM ('LINE', 'UNIT');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_prov_source') THEN
      CREATE TYPE buyback_prov_source AS ENUM ('PREV_OWNER_DOCS', 'DEALER_STOCK');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_leg') THEN
      CREATE TYPE buyback_leg AS ENUM ('DEALER', 'VENDOR');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_final_offer_status') THEN
      CREATE TYPE buyback_final_offer_status AS ENUM ('SENT', 'ACCEPTED', 'DECLINED');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_margin_mode') THEN
      CREATE TYPE buyback_margin_mode AS ENUM ('FLAT', 'PCT');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_notify_party') THEN
      CREATE TYPE buyback_notify_party AS ENUM ('DEALER', 'ADMIN', 'VENDOR');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_notify_channel') THEN
      CREATE TYPE buyback_notify_channel AS ENUM ('WHATSAPP', 'EMAIL', 'PORTAL');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'buyback_notify_status') THEN
      CREATE TYPE buyback_notify_status AS ENUM ('PENDING', 'SENT', 'FAILED');
    END IF;
  END $$;

  ------------------------------------------------------------------------------
  -- 2. CATALOG (M16) — every V+Ah combo is its own variant (BRD P1).
  --    Two estimated buyback prices per variant: Working and Dead.
  ------------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS catalog_variants (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type                      TEXT NOT NULL,              -- display SKU name, e.g. '60V 120Ah Li-ion'
    chemistry                 TEXT,                       -- 'Li-ion' | 'LFP' | 'Lead-acid' | …
    voltage                   NUMERIC(6,2) NOT NULL,      -- nominal, e.g. 60.00
    ah                        NUMERIC(7,2) NOT NULL,      -- e.g. 120.00
    unit_price                NUMERIC(12,2),              -- OEM/list reference
    est_buyback_price_working NUMERIC(12,2),              -- prototype's bWork
    est_buyback_price_dead    NUMERIC(12,2),              -- prototype's bDead
    price_book_version        INTEGER NOT NULL DEFAULT 1,
    active                    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS catalog_variants_type_v_ah_unique
    ON catalog_variants (type, voltage, ah);
  CREATE INDEX IF NOT EXISTS catalog_variants_active_idx
    ON catalog_variants (active) WHERE active;

  ------------------------------------------------------------------------------
  -- 3. ENTITY ROLE LAYER (BRD §8 — sits on top of the existing `accounts`
  --    business-entity + KYC store; does not duplicate it).
  ------------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS business_entity_roles (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id    VARCHAR(255) NOT NULL REFERENCES accounts(id),
    role         buyback_entity_role NOT NULL,
    status       TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | ACTIVE | SUSPENDED
    agreement_id TEXT,                             -- Digio doc id; Sprint 4 (M19)
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS business_entity_roles_entity_role_unique
    ON business_entity_roles (entity_id, role);

  ------------------------------------------------------------------------------
  -- 4. PICKUP ADDRESSES — `accounts` holds only ONE address, but a dealer picks
  --    a pickup location at intake (M02: "Shop — Nashik" / "Warehouse — Pune").
  --    Sprint 1 uses order-level (one address); per-batch/per-line is Sprint 3.
  ------------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS buyback_pickup_addresses (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id     VARCHAR(255) NOT NULL REFERENCES accounts(id),
    label         TEXT NOT NULL,                   -- 'Shop — Nashik'
    address_line1 TEXT NOT NULL,
    address_line2 TEXT,
    city          TEXT,
    state         TEXT,
    pincode       VARCHAR(6),
    contact_name  TEXT,
    contact_phone VARCHAR(20),
    is_default    BOOLEAN NOT NULL DEFAULT FALSE,
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS buyback_pickup_addresses_entity_idx
    ON buyback_pickup_addresses (entity_id) WHERE active;

  ------------------------------------------------------------------------------
  -- 5. REQUEST → BATCH → LINE → UNIT
  --    INVARIANT 1: no pricing column anywhere on buyback_requests.
  ------------------------------------------------------------------------------
  -- Human-readable request references (BB-1024, BB-1025 …) — quoted on the phone
  -- and searchable in M23. A sequence, not max(request_no)+1, which would hand two
  -- concurrent dealers the same number. Starts at 1024 to match the design.
  CREATE SEQUENCE IF NOT EXISTS buyback_request_no_seq START WITH 1024;

  -- NOTE: there is deliberately NO status column here. BRD §2: "Persist status as
  -- one enum on the deal; never scattered booleans." buyback_deals.status is the
  -- single source of truth, and a deal row is created alongside every request (at
  -- DRAFT). The review queue joins to it.
  CREATE TABLE IF NOT EXISTS buyback_requests (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Human-readable reference shown in the UI and searchable in M23 (e.g. 'BB-1024').
    request_no       TEXT NOT NULL,
    dealer_entity_id VARCHAR(255) NOT NULL REFERENCES accounts(id),
    source_channel   buyback_source_channel NOT NULL DEFAULT 'WEB',
    created_by       UUID,                          -- users.id
    submitted_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS buyback_requests_request_no_unique
    ON buyback_requests (request_no);
  -- Dealer dashboard (M01) lists a dealer's own requests, newest first.
  CREATE INDEX IF NOT EXISTS buyback_requests_dealer_created_idx
    ON buyback_requests (dealer_entity_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS buyback_batches (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id        UUID NOT NULL REFERENCES buyback_requests(id) ON DELETE CASCADE,
    pickup_address_id UUID REFERENCES buyback_pickup_addresses(id),
    status            TEXT NOT NULL DEFAULT 'OPEN',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS buyback_batches_request_idx
    ON buyback_batches (request_id);

  CREATE TABLE IF NOT EXISTS buyback_lines (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id                    UUID NOT NULL REFERENCES buyback_batches(id) ON DELETE CASCADE,
    variant_id                  UUID NOT NULL REFERENCES catalog_variants(id),
    quantity                    INTEGER NOT NULL CHECK (quantity >= 1),
    condition                   buyback_condition NOT NULL,
    measured_voltage            NUMERIC(6,2),           -- auto-filled, dealer-editable
    expected_price_per_unit     NUMERIC(12,2),          -- dealer's ask
    -- Snapshot of the price book the estimate came from, so a later catalog edit
    -- can never move an open request's reference price (M16 AC).
    price_book_version_at_create INTEGER NOT NULL DEFAULT 1,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS buyback_lines_batch_idx
    ON buyback_lines (batch_id);

  -- qty N → Unit 1..N, auto-generated at line create (BRD P3).
  CREATE TABLE IF NOT EXISTS buyback_units (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    line_id    UUID NOT NULL REFERENCES buyback_lines(id) ON DELETE CASCADE,
    unit_no    INTEGER NOT NULL CHECK (unit_no >= 1),
    status     TEXT NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS buyback_units_line_unit_unique
    ON buyback_units (line_id, unit_no);

  ------------------------------------------------------------------------------
  -- 6. EVIDENCE — photos (M03) + provenance (M04)
  ------------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS buyback_photos (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    line_id         UUID NOT NULL REFERENCES buyback_lines(id) ON DELETE CASCADE,
    unit_id         UUID REFERENCES buyback_units(id) ON DELETE CASCADE,  -- optional unit tagging
    s3_key_original TEXT NOT NULL,
    s3_key_display  TEXT,
    phash           TEXT,          -- Sprint 3 (nightly dedup job) — NULL for now
    exif            JSONB,
    taken_at        TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  -- Submit gate counts photos per line (min 5); dedup job scans by phash.
  CREATE INDEX IF NOT EXISTS buyback_photos_line_idx  ON buyback_photos (line_id);
  CREATE INDEX IF NOT EXISTS buyback_photos_phash_idx ON buyback_photos (phash) WHERE phash IS NOT NULL;

  -- Single owner identity per record (BRD P2). scope=LINE is the default; a unit
  -- override is a second row with scope=UNIT. Bulk-apply copies across units.
  CREATE TABLE IF NOT EXISTS provenance_records (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope             buyback_prov_scope NOT NULL,
    line_id           UUID REFERENCES buyback_lines(id) ON DELETE CASCADE,
    unit_id           UUID REFERENCES buyback_units(id) ON DELETE CASCADE,
    source_type       buyback_prov_source NOT NULL,
    prev_owner_name   TEXT,           -- usually the driver
    prev_owner_phone  VARCHAR(20),
    vehicle_no        TEXT,
    rc_number         TEXT,
    id_proof_type     TEXT,           -- 'PAN' | 'DL' | …
    id_proof_s3       TEXT,
    payment_proof_ref TEXT,           -- optional purchase proof
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- A record is anchored to exactly one of line / unit, matching its scope.
    CONSTRAINT provenance_records_scope_target_chk CHECK (
      (scope = 'LINE' AND line_id IS NOT NULL AND unit_id IS NULL) OR
      (scope = 'UNIT' AND unit_id IS NOT NULL)
    )
  );
  CREATE INDEX IF NOT EXISTS provenance_records_line_idx ON provenance_records (line_id);
  CREATE INDEX IF NOT EXISTS provenance_records_unit_idx ON provenance_records (unit_id);

  ------------------------------------------------------------------------------
  -- 7. INFO REQUESTS (M06 / BRD P4) — unit-targeted, so the dealer's banner can
  --    name exactly the batteries in question ("Unit 2"), not the whole request.
  ------------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS info_requests (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id     UUID NOT NULL REFERENCES buyback_requests(id) ON DELETE CASCADE,
    target_line_ids UUID[] NOT NULL DEFAULT '{}',
    target_unit_ids UUID[] NOT NULL DEFAULT '{}',
    checklist      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ['RC / vehicle document', …]
    note           TEXT,
    raised_by      UUID,                                 -- users.id
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at    TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS info_requests_request_idx
    ON info_requests (request_id, created_at DESC);

  ------------------------------------------------------------------------------
  -- 8. DEAL — the state machine's row. One deal per request.
  ------------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS buyback_deals (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id    UUID NOT NULL REFERENCES buyback_requests(id) ON DELETE CASCADE,
    status        buyback_deal_status NOT NULL DEFAULT 'DRAFT',
    -- Bumped by every reopen (U5). Final offers and lock generations are stamped
    -- with the version they belong to.
    offer_version INTEGER NOT NULL DEFAULT 1,
    floor_total   NUMERIC(14,2),   -- breakeven; blocks vendor routing below it (M08)
    locked_at     TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS buyback_deals_request_unique
    ON buyback_deals (request_id);
  CREATE INDEX IF NOT EXISTS buyback_deals_status_created_idx
    ON buyback_deals (status, created_at DESC);

  ------------------------------------------------------------------------------
  -- 9. NEGOTIATION (M07)
  --    INVARIANT 2: negotiation_rounds has NO amount column. Every counter is
  --    itemized per SKU in negotiation_round_lines. A lump-sum offer cannot be
  --    written to this schema.
  ------------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS negotiation_rounds (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id        UUID NOT NULL REFERENCES buyback_deals(id) ON DELETE CASCADE,
    leg            buyback_leg NOT NULL DEFAULT 'DEALER',
    counterparty_id VARCHAR(255),   -- accounts.id (dealer now; vendor in Sprint 2)
    round_no       INTEGER NOT NULL,
    offered_by     UUID,            -- users.id
    offered_by_role TEXT NOT NULL,  -- 'dealer' | 'admin'
    note           TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS negotiation_rounds_deal_leg_round_unique
    ON negotiation_rounds (deal_id, leg, round_no);

  CREATE TABLE IF NOT EXISTS negotiation_round_lines (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    round_id              UUID NOT NULL REFERENCES negotiation_rounds(id) ON DELETE CASCADE,
    line_id               UUID NOT NULL REFERENCES buyback_lines(id) ON DELETE CASCADE,
    offered_price_per_unit NUMERIC(12,2) NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS negotiation_round_lines_round_line_unique
    ON negotiation_round_lines (round_id, line_id);

  ------------------------------------------------------------------------------
  -- 10. FINAL OFFERS (M07 / U5) — itemized per SKU, ONE overall accept/decline,
  --     versioned (a reopen bumps the deal's offer_version → next offer is v+1).
  --     Again: no amount column on the header.
  ------------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS final_offers (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id      UUID NOT NULL REFERENCES buyback_deals(id) ON DELETE CASCADE,
    version_no   INTEGER NOT NULL,
    status       buyback_final_offer_status NOT NULL DEFAULT 'SENT',
    note         TEXT,
    sent_by      UUID,             -- users.id
    sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX IF NOT EXISTS final_offers_deal_version_unique
    ON final_offers (deal_id, version_no);

  CREATE TABLE IF NOT EXISTS final_offer_lines (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    final_offer_id UUID NOT NULL REFERENCES final_offers(id) ON DELETE CASCADE,
    line_id        UUID NOT NULL REFERENCES buyback_lines(id) ON DELETE CASCADE,
    price_per_unit NUMERIC(12,2) NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS final_offer_lines_offer_line_unique
    ON final_offer_lines (final_offer_id, line_id);

  ------------------------------------------------------------------------------
  -- 11. DEAL LINE LOCKS (M08) — the immutable per-SKU snapshot that EVERY
  --     document and report reads from. Margin never drifts.
  --
  --     Written ONCE, at MARGIN_SET: dealer_price is copied from the ACCEPTED
  --     final_offer_lines, and the margin is known at the same moment. Rows are
  --     never UPDATEd. A reopen bumps offer_version and INSERTs a NEW generation;
  --     the live lock is the generation matching the deal's accepted offer_version.
  --     vendor_ask / vendor_price are filled on the vendor leg (Sprint 2).
  ------------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS deal_line_locks (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id       UUID NOT NULL REFERENCES buyback_deals(id) ON DELETE CASCADE,
    line_id       UUID NOT NULL REFERENCES buyback_lines(id) ON DELETE CASCADE,
    offer_version INTEGER NOT NULL,
    dealer_price  NUMERIC(12,2) NOT NULL,     -- ₹/unit the dealer accepted
    margin_value  NUMERIC(12,2) NOT NULL,     -- resolved RUPEES/unit, whatever the mode
    margin_mode   buyback_margin_mode NOT NULL,
    vendor_ask    NUMERIC(12,2),              -- dealer_price + margin_value (Sprint 2 ask)
    vendor_price  NUMERIC(12,2),              -- what the vendor actually agreed (Sprint 2)
    locked_by     UUID,                       -- users.id
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS deal_line_locks_deal_line_version_unique
    ON deal_line_locks (deal_id, line_id, offer_version);

  ------------------------------------------------------------------------------
  -- 12. ACTIVITY LOG (M21) — INSERT-only, written in the SAME transaction as the
  --     change it records.
  --
  --     INVARIANT 5 is enforced by a trigger rather than a REVOKE: the app very
  --     likely connects as the table owner, and an owner's rights survive
  --     REVOKE. A BEFORE UPDATE OR DELETE trigger binds the owner too.
  ------------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS buyback_activity_log (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES buyback_requests(id) ON DELETE CASCADE,
    deal_id    UUID REFERENCES buyback_deals(id) ON DELETE CASCADE,
    actor_id   UUID,                    -- users.id; NULL for system actions
    role       TEXT NOT NULL,           -- 'dealer' | 'admin' | 'system'
    action     TEXT NOT NULL,           -- the state-machine action, e.g. 'send_final_offer'
    before     JSONB,                   -- before→after for prices (BRD M21)
    after      JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS buyback_activity_log_request_idx
    ON buyback_activity_log (request_id, created_at);

  CREATE OR REPLACE FUNCTION buyback_activity_log_immutable()
  RETURNS trigger AS $fn$
  BEGIN
    RAISE EXCEPTION 'buyback_activity_log is INSERT-only (E-185): % denied', TG_OP;
  END;
  $fn$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS buyback_activity_log_no_update_delete ON buyback_activity_log;
  CREATE TRIGGER buyback_activity_log_no_update_delete
    BEFORE UPDATE OR DELETE ON buyback_activity_log
    FOR EACH ROW EXECUTE FUNCTION buyback_activity_log_immutable();

  ------------------------------------------------------------------------------
  -- 13. NOTIFICATION EVENTS (M20 / U4) — every state change emits EXACTLY ONE
  --     event, written in the same transaction as the change.
  --
  --     Named buyback_notification_events, not `notifications`: that table already
  --     exists as the CRM's in-app per-user bell (user_id / lead_id / read) and is
  --     a different thing entirely. This is an outbound dispatch log.
  --
  --     INVARIANT 6: idempotency_key is UNIQUE, so a retried transition cannot
  --     double-emit, and a missing row means a silent transition (a bug).
  --     Dispatch itself is a separate concern — rows land as PENDING.
  ------------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS buyback_notification_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id         UUID REFERENCES buyback_deals(id) ON DELETE CASCADE,
    request_id      UUID NOT NULL REFERENCES buyback_requests(id) ON DELETE CASCADE,
    event_type      TEXT NOT NULL,       -- state-machine action, e.g. 'request_info'
    recipient_party buyback_notify_party NOT NULL,
    channel         buyback_notify_channel NOT NULL,
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    idempotency_key TEXT NOT NULL,       -- '{deal_id}:{action}:{offer_version}'
    delivery_status buyback_notify_status NOT NULL DEFAULT 'PENDING',
    sent_at         TIMESTAMPTZ,
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS buyback_notification_events_idem_unique
    ON buyback_notification_events (idempotency_key);
  -- The dispatcher drains PENDING oldest-first.
  CREATE INDEX IF NOT EXISTS buyback_notification_events_pending_idx
    ON buyback_notification_events (delivery_status, created_at)
    WHERE delivery_status = 'PENDING';

  ------------------------------------------------------------------------------
  -- 14. COMMENTS — the invariants, recorded where the next engineer will find them.
  ------------------------------------------------------------------------------
  COMMENT ON TABLE  buyback_requests IS
    'E-185 — peakAmp buyback request. INVARIANT: carries NO pricing. Prices live on buyback_lines, the offer tables and deal_line_locks; totals are derived.';
  COMMENT ON TABLE  negotiation_rounds IS
    'E-185 — one negotiation round. INVARIANT: no amount column — every counter is itemized per SKU in negotiation_round_lines (BRD P5).';
  COMMENT ON TABLE  final_offers IS
    'E-185 — versioned final offer. Itemized in final_offer_lines; the dealer gives ONE overall accept/decline (U5). A reopen bumps buyback_deals.offer_version.';
  COMMENT ON TABLE  deal_line_locks IS
    'E-185 — immutable per-SKU price+margin snapshot. Written once at MARGIN_SET, never updated; a reopen inserts a new offer_version generation. All documents and reports read margin from here, never from live catalog prices (M22 AC).';
  COMMENT ON TABLE  buyback_activity_log IS
    'E-185 — INSERT-only audit trail (M21), written in the same transaction as the change. UPDATE/DELETE are blocked by the buyback_activity_log_no_update_delete trigger.';
  COMMENT ON TABLE  buyback_notification_events IS
    'E-185 — outbound notification dispatch log (M20). Exactly one row per state change, enforced by UNIQUE(idempotency_key). NOT the same as the CRM in-app `notifications` table.';
  COMMENT ON COLUMN buyback_deals.offer_version IS
    'E-185 — bumped by every reopen (U5). Final offers and deal_line_locks generations are stamped with the version they belong to.';
  COMMENT ON COLUMN buyback_lines.price_book_version_at_create IS
    'E-185 — snapshot of the catalog price book, so a later catalog edit never moves an open request''s reference price (M16 AC).';
