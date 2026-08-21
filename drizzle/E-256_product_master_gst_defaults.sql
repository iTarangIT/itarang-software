------------------------------------------------------------------------------
-- E-256: Product-master GST defaults — battery 18%, charger 5%,
--        paraphernalia 18%, with the matching HSN codes.
--
-- WHY. E-242 added hsn_code / gst_rate_pct to the three product masters
-- nullable with no backfill ("a guessed rate is a wrong number on a tax
-- document") and no write surface was ever built, so every row is NULL and
-- every quotation PDF prints "IGST % Not set" plus the unset-tax banner.
-- On 2026-08-20 the business fixed the rates by asset type — battery 18,
-- charger 5, paraphernalia 18, the same values the loan calculator has always
-- encoded (calc_component_prices: goods ×1.18, charger ×1.05) — so they are
-- now POLICY, not guesses, and may appear on a tax document.
--
-- WHAT THIS FILE DOES.
--   1. Backfills gst_rate_pct on rows where it is NULL, and hsn_code where
--      THAT is NULL, per asset type. A rate or HSN someone has already set is
--      never touched (WHERE … IS NULL), which is what makes the UPDATEs
--      idempotent and re-runnable.
--   2. Sets column DEFAULTs so product rows created after this file carry the
--      policy values without the admin having to type them.
--
-- The app code ships a matching fallback (DEFAULT_TAX_BY_ASSET_TYPE in
-- src/lib/leads/quote-pdf/view.ts), so a database this file has not reached
-- still produces a correctly-taxed quotation; this file makes the catalogue
-- itself canonical and per-product overridable via the product-master admin.
--
-- HSN codes (also the values in the quote-pdf golden test):
--   85076000  lithium-ion accumulators (battery)
--   85044030  battery chargers / static converters (charger @5%)
--   85079090  parts of accumulators (paraphernalia)
--
-- DDL is additive; the only DML fills NULLs. Safe to re-run.
------------------------------------------------------------------------------

BEGIN;

-- 1. Batteries: 18% / 85076000 ------------------------------------------------
DO $do$ BEGIN
    UPDATE product_master_batteries SET gst_rate_pct = 18 WHERE gst_rate_pct IS NULL;
    UPDATE product_master_batteries SET hsn_code = '85076000' WHERE hsn_code IS NULL;
    ALTER TABLE product_master_batteries ALTER COLUMN gst_rate_pct SET DEFAULT 18;
    ALTER TABLE product_master_batteries ALTER COLUMN hsn_code SET DEFAULT '85076000';
EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'skip: product_master_batteries absent or E-242 not applied here';
END; $do$;

-- 2. Chargers: 5% / 85044030 ---------------------------------------------------
DO $do$ BEGIN
    UPDATE product_master_chargers SET gst_rate_pct = 5 WHERE gst_rate_pct IS NULL;
    UPDATE product_master_chargers SET hsn_code = '85044030' WHERE hsn_code IS NULL;
    ALTER TABLE product_master_chargers ALTER COLUMN gst_rate_pct SET DEFAULT 5;
    ALTER TABLE product_master_chargers ALTER COLUMN hsn_code SET DEFAULT '85044030';
EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'skip: product_master_chargers absent or E-242 not applied here';
END; $do$;

-- 3. Paraphernalia: 18% / 85079090 ---------------------------------------------
DO $do$ BEGIN
    UPDATE product_master_paraphernalia SET gst_rate_pct = 18 WHERE gst_rate_pct IS NULL;
    UPDATE product_master_paraphernalia SET hsn_code = '85079090' WHERE hsn_code IS NULL;
    ALTER TABLE product_master_paraphernalia ALTER COLUMN gst_rate_pct SET DEFAULT 18;
    ALTER TABLE product_master_paraphernalia ALTER COLUMN hsn_code SET DEFAULT '85079090';
EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'skip: product_master_paraphernalia absent or E-242 not applied here';
END; $do$;

-- 4. Self-documentation ---------------------------------------------------------
DO $do$ BEGIN
    EXECUTE $c$COMMENT ON COLUMN product_master_batteries.gst_rate_pct IS
        'E-242/E-256. GST rate the quotation prints for this product. E-256 backfilled 18 (business policy, 2026-08-20) and set it as the column default; editable per product in the product-master admin. NULL only for an asset type the policy does not name.'$c$;
    EXECUTE $c$COMMENT ON COLUMN product_master_chargers.gst_rate_pct IS
        'E-242/E-256. GST rate the quotation prints. E-256 backfilled 5 (business policy, 2026-08-20) and set it as the column default; editable per product in the product-master admin.'$c$;
    EXECUTE $c$COMMENT ON COLUMN product_master_paraphernalia.gst_rate_pct IS
        'E-242/E-256. GST rate the quotation prints. E-256 backfilled 18 (business policy, 2026-08-20) and set it as the column default; editable per product in the product-master admin.'$c$;
EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'skip: comments (a target table/column is absent)';
END; $do$;

COMMIT;
