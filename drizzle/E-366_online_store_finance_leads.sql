-- =============================================================================
-- E-366 — ONLINE STORE "BUY ON FINANCE" ENQUIRIES (Store R-15, decision D-12)
-- =============================================================================
-- WHY.
--   shop.itarang.com forwards every "Buy on finance" enquiry to the CRM
--   (POST /api/integrations/online-store/finance-lead). Each one becomes a
--   customer lead on the iTarang house dealer with lead_source = 'online_store'.
--   The store retries on any non-2xx, so the CRM has to recognise a repeat of
--   the same enquiry and answer with the lead it already made.
--
-- WHAT. online_store_finance_leads — one row per store enquiry:
--   store_ref   the store's own id for the enquiry; UNIQUE = the idempotency
--               key (a retry finds the row and gets the same lead_id back)
--   lead_id     leads.id of the lead it created
--   page        'product' | 'checkout' — where the customer pressed the button
--   product_*   what they were looking at, as the store sent it
--   pincode     the 6-digit pincode (leads has no pincode column)
--   payload     the request body, verbatim
--
-- leads itself needs no DDL: lead_source (varchar 50) and source_channel
-- (varchar 20) are free text, and 'online_store' fits both.
--
-- No backfill. Required before the intake route deploys (it writes this
-- table); nothing else depends on it.
--
-- Idempotent: re-running is a no-op. Strictly additive.
-- =============================================================================

CREATE TABLE IF NOT EXISTS online_store_finance_leads (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    store_ref      varchar(100) NOT NULL,
    lead_id        varchar(255) NOT NULL,
    page           varchar(16),
    product_sku    varchar(100),
    product_title  text,
    product_url    text,
    price_paise    bigint,
    pincode        varchar(6),
    payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS online_store_finance_leads_store_ref_uniq
    ON online_store_finance_leads (store_ref);
CREATE INDEX IF NOT EXISTS online_store_finance_leads_lead_idx
    ON online_store_finance_leads (lead_id);
CREATE INDEX IF NOT EXISTS online_store_finance_leads_created_idx
    ON online_store_finance_leads (created_at DESC);
