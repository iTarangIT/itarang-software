-- E-356: Account-level quotations (24 Oct meeting, Kartik — items 8–11).
--
-- A quotation raised for an onboarded DEALER ACCOUNT (accounts.id) by its
-- owner from My Dealers, separate from the lead quotations in
-- dealer_lead_commercials (E-116 / E-221 / E-242 / E-243). Same approval rule
-- as a lead quote — every line at or above its OEM reference price and cash
-- terms releases at once; anything else waits for the CEO — but its own rows,
-- its own dispatch log and its own signed dealer link, so nothing about the
-- lead flow changes.
--
-- 1. account_quotations — one row per version on an account; version_no is
--    unique per account, exactly one row per account is_current.
-- 2. account_quotation_dispatches — one row per channel per send attempt,
--    never updated (same shape as quotation_dispatches).
--
-- Additive and idempotent — safe to re-run. No FKs, per this table family's
-- convention (accounts.id is varchar). Readers probe with to_regclass
-- (src/lib/accounts/quotations/tables.ts), so an unapplied environment shows
-- "not set up" instead of 500ing.

-- ── 1. account_quotations ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS account_quotations (
    quotation_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id              varchar(255) NOT NULL,
    version_no              integer NOT NULL,
    is_current              boolean NOT NULL DEFAULT true,
    event_type              varchar(30) NOT NULL,          -- quote_issue | quote_revision
    product_lines           jsonb NOT NULL DEFAULT '[]'::jsonb,
    price_quoted            numeric(14,2),
    -- Terms, resolved exactly as on a lead quote (src/lib/leads/quoteTermsRules.ts).
    payment_method          varchar(20),
    dealer_payment_terms    varchar(10),                    -- cash | credit
    credit_days             integer,
    credit_terms            text,
    delivery_terms          text,
    warranty_terms          text,
    notes                   text,
    -- Approval (pending | approved | rejected; auto | manual).
    approval_status         varchar(20) NOT NULL DEFAULT 'pending',
    approval_mode           varchar(10),
    oem_evaluation          jsonb,
    approved_by             uuid,
    approved_at             timestamptz,
    rejection_reason        text,
    -- The generated document.
    quote_number            varchar(50),
    quote_pdf_url           text,
    quote_pdf_generated_at  timestamptz,
    quote_pdf_error         text,
    quote_snapshot          jsonb,
    -- What the dealer said back (approved | declined; link | whatsapp).
    dealer_decision         varchar(20),
    dealer_decision_at      timestamptz,
    dealer_decision_via     varchar(20),
    dealer_decision_actor   text,
    dealer_decision_note    text,
    withdrawn_at            timestamptz,
    withdrawn_by            uuid,
    withdraw_reason         text,
    created_by              uuid NOT NULL,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS account_quotations_account_version_uniq
    ON account_quotations (account_id, version_no);
CREATE INDEX IF NOT EXISTS account_quotations_account_idx
    ON account_quotations (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS account_quotations_pending_idx
    ON account_quotations (created_at) WHERE approval_status = 'pending';

-- ── 2. account_quotation_dispatches ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS account_quotation_dispatches (
    dispatch_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    quotation_id         uuid NOT NULL,
    account_id           varchar(255) NOT NULL,
    channel              varchar(20) NOT NULL,              -- email | whatsapp
    recipient            text NOT NULL,
    status               varchar(20) NOT NULL,              -- sent | failed
    provider_message_id  text,
    error                text,
    sent_by              text NOT NULL,
    cc_recipients        jsonb,
    created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_quotation_dispatches_quotation_idx
    ON account_quotation_dispatches (quotation_id, created_at);
CREATE INDEX IF NOT EXISTS account_quotation_dispatches_account_idx
    ON account_quotation_dispatches (account_id, created_at);
