-- E-323 — the product LIST PRICE (tracker IDs 4 and 47, handover P1-14,
-- decided 26 Sep 2026).
--
-- Until now there was one price per product: the OEM price, internal, which
-- decides whether a quote needs the CEO. The quotation showed no discount.
--
--   product_list_prices          the price printed on the quotation as "List
--       price". Set by Admin or CEO, optional (never a gate), dated exactly
--       like the OEM price book: append-only, each open row owns a half-open
--       window [effective_from, valid_until), a revision closes the row it
--       replaces (effective_to), a future start date is a scheduled successor.
--       Always >= the OEM price in the same window — checked at save, both
--       when a list price is set and when an OEM price is raised.
--   dealer_lead_commercials.list_price_snapshot
--       the list price each line was quoted against, frozen on the quote:
--       { lines: [{ asset_type, product_id, list_price, list_price_id }] }.
--       NULL on every quote written before this migration — those documents
--       keep printing without a List price / Discount column.
--
-- The OEM price stays internal and the approval rule is untouched. Where no
-- list price is set, the OEM price prints as the list price (decision 5).
--
-- DDL: additive + idempotent. Mirrored in schema.ts. Re-run = no-op.

CREATE TABLE IF NOT EXISTS product_list_prices (
    price_id        uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_type      varchar(30)   NOT NULL,
    product_id      text          NOT NULL,
    model_id        varchar(100),
    product_name    varchar(200),
    list_price      numeric(14,2) NOT NULL,
    effective_from  timestamptz   NOT NULL DEFAULT now(),
    effective_to    timestamptz,
    valid_until     timestamptz,
    note            text,
    created_by      text          NOT NULL,
    created_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_list_prices_product_idx
    ON product_list_prices (product_id, effective_from);

-- Several open rows per product (the one in force plus scheduled successors),
-- never two starting at the same instant. Windows are kept from overlapping by
-- setListPrice(), which locks the product's open rows FOR UPDATE.
CREATE UNIQUE INDEX IF NOT EXISTS product_list_prices_open_from_uniq
    ON product_list_prices (asset_type, product_id, effective_from)
    WHERE effective_to IS NULL;

DO $do$
BEGIN
    ALTER TABLE dealer_lead_commercials
        ADD COLUMN IF NOT EXISTS list_price_snapshot jsonb;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'E-323: dealer_lead_commercials does not exist — skip';
END;
$do$;
