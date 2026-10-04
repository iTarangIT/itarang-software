-- E-321: Dealer account ownership, GSTIN-matched invoice credit, and the
-- optional quotation list price. Tracker P1 IDs 4, 5, 67, 68, 69
-- (handover P1-1, P1-2, P1-4, P1-5, P1-6, P1-11, P1-14), 2026-10-03.
--
-- WHY NEW TABLES AND NOT COLUMNS ON accounts
--   `accounts` is read by buyback, inventory, approval and the sales dashboard.
--   Drizzle names every mirrored column in its SQL, so a column added here and
--   in schema.ts would break every one of those readers on any database where
--   this file is not yet applied. New tables are read through a to_regclass
--   probe instead (src/lib/accounts/tables.ts), so an unapplied environment
--   degrades to today's behaviour rather than 500ing.
--
-- 1. account_ownership — one row per dealer account (accounts.id = dealer
--    code): the CURRENT owner (iTarang salesperson), who onboarded it, and
--    whether it came through a lead or a direct onboarding. owner_user_id is
--    NULL until Admin / CEO assigns one — nothing is assigned automatically.
-- 2. account_owner_history — append-only windows [effective_from,
--    effective_to). Revenue is credited to the owner whose window contains the
--    invoice date, so reassigning a dealer never moves past revenue.
-- 3. account_gstins — extra GSTINs that identify an account (a corrected
--    GSTIN's predecessor, or one learned by "Link to account" on an invoice).
--    accounts.gstin stays the primary; invoices match either.
-- 4. invoice_account_links — a person's decision about one invoice: linked to
--    an account, or "not a dealer sale". Keyed (source, invoice_id) because
--    invoices live in two tables (zoho_invoices, sales_invoices).
-- 5. product_list_prices — the optional, dated list price printed on quotes.
--    Same append-only windowed shape as oem_reference_prices (E-226 / E-230).
--    Never below the OEM price in any overlapping window (enforced in
--    src/lib/leads/listPrices.ts). Ships empty: with no list price the OEM
--    price prints as list price, so no quote changes on day 1.
--
-- Additive and idempotent — safe to re-run. No FKs, per this table family's
-- convention (accounts.id is varchar; users live on the same database).

-- ── 1. account_ownership ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS account_ownership (
    account_id            varchar(255) PRIMARY KEY,
    owner_user_id         uuid,
    onboarded_by_user_id  uuid,
    came_through          varchar(10),          -- 'lead' | 'direct'
    source_dealer_lead_id text,
    source_application_id text,
    updated_by            uuid,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_ownership_owner_idx
    ON account_ownership (owner_user_id);

-- ── 2. account_owner_history ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS account_owner_history (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id     varchar(255) NOT NULL,
    owner_user_id  uuid,                         -- NULL = deliberately unowned
    effective_from timestamptz NOT NULL,
    effective_to   timestamptz,                  -- NULL = current
    reason         text,
    changed_by     uuid,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_owner_history_account_idx
    ON account_owner_history (account_id, effective_from);
-- At most one open window per account.
CREATE UNIQUE INDEX IF NOT EXISTS account_owner_history_open_uniq
    ON account_owner_history (account_id) WHERE effective_to IS NULL;

-- ── 3. account_gstins ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS account_gstins (
    gstin      varchar(15) PRIMARY KEY,          -- normalised: upper, no spaces
    account_id varchar(255) NOT NULL,
    source     varchar(20) NOT NULL,             -- 'correction' | 'invoice_link'
    added_by   uuid,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_gstins_account_idx
    ON account_gstins (account_id);

-- ── 4. invoice_account_links ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_account_links (
    source     varchar(10) NOT NULL,             -- 'zoho' | 'drive'
    invoice_id text NOT NULL,                    -- zoho_invoices.id / sales_invoices.id
    account_id varchar(255),                     -- NULL when kind = 'not_dealer'
    kind       varchar(12) NOT NULL,             -- 'linked' | 'not_dealer'
    note       text,
    linked_by  uuid,
    linked_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source, invoice_id)
);
CREATE INDEX IF NOT EXISTS invoice_account_links_account_idx
    ON invoice_account_links (account_id);

-- ── 5. product_list_prices ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_list_prices (
    price_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_type     varchar(30) NOT NULL,
    product_id     text NOT NULL,
    model_id       varchar(100),
    product_name   varchar(200),
    list_price     numeric(14, 2) NOT NULL,
    effective_from timestamptz NOT NULL DEFAULT now(),
    effective_to   timestamptz,                  -- superseded-at (bookkeeping)
    valid_until    timestamptz,                  -- declared expiry, exclusive
    note           text,
    created_by     text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_list_prices_product_idx
    ON product_list_prices (product_id, effective_from);
