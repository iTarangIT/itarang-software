-- =============================================================================
-- E-336 — QUOTE DEAL CARD: onboarding fee, expected batteries and finance files
--         per month, on every quote (tracker ID 172, 2026-10-12)
-- =============================================================================
-- WHY. The CEO approves a quote seeing the product lines and the terms, but
-- not the answers that make it a good deal: does the dealer pay an onboarding
-- fee, how many batteries will they buy a month after the first order, how
-- many of their customers buy on a loan. Nothing in the CRM held any of these.
--
-- WHAT. Four nullable columns on dealer_lead_commercials (one set per quote
-- version, copied forward to terms events):
--
--   onboarding_fee                     numeric(12,2)  rupees; 0 = waived
--   fee_waived_reason                  text           required when the fee is 0
--   expected_batteries_per_month       integer        after the first order, ≥ 1
--   expected_finance_files_per_month   integer        ≥ 0; replaces the
--                                                     Customer finance Yes / No
--                                                     (customer_finance is now
--                                                     written as files > 0)
--
-- Required on every quote saved from Update commercials (Kartik, 10 Oct). They
-- lock once the CEO approves the quote or the dealer says yes; after that only
-- the Sales Head changes them (POST /api/inside-sales/lead/[id]/deal-card),
-- with an audit row. The fee prints on the dealer's quotation; the two
-- estimates are internal and never print.
--
-- NOT mirrored in src/lib/db/schema.ts on purpose: dealer_lead_commercials is
-- inserted through Drizzle (createCommercial.ts), and Drizzle names every
-- schema column, so a mirrored column would break every quote on a database
-- without this file. Readers use to_jsonb(row) and the writer a has-column
-- probe (src/lib/leads/dealCard.ts): without it a quote saves without its deal
-- card and every screen shows "—".
--
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

ALTER TABLE dealer_lead_commercials ADD COLUMN IF NOT EXISTS onboarding_fee numeric(12, 2);
ALTER TABLE dealer_lead_commercials ADD COLUMN IF NOT EXISTS fee_waived_reason text;
ALTER TABLE dealer_lead_commercials ADD COLUMN IF NOT EXISTS expected_batteries_per_month integer;
ALTER TABLE dealer_lead_commercials ADD COLUMN IF NOT EXISTS expected_finance_files_per_month integer;

DO $do$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dlc_deal_card_ranges') THEN
        ALTER TABLE dealer_lead_commercials
            ADD CONSTRAINT dlc_deal_card_ranges CHECK (
                (onboarding_fee IS NULL OR onboarding_fee >= 0)
                AND (expected_batteries_per_month IS NULL OR expected_batteries_per_month >= 1)
                AND (expected_finance_files_per_month IS NULL OR expected_finance_files_per_month >= 0)
            ) NOT VALID;
    END IF;
END;
$do$;

COMMENT ON COLUMN dealer_lead_commercials.onboarding_fee IS
    'E-336 (ID 172) — onboarding fee agreed on this quote, rupees; 0 = waived (fee_waived_reason says why). Prints on the dealer quotation.';
COMMENT ON COLUMN dealer_lead_commercials.fee_waived_reason IS
    'E-336 (ID 172) — why the onboarding fee is 0. Required when onboarding_fee = 0.';
COMMENT ON COLUMN dealer_lead_commercials.expected_batteries_per_month IS
    'E-336 (ID 172) — batteries the dealer says they will buy from us a month after the first order. Internal; never prints.';
COMMENT ON COLUMN dealer_lead_commercials.expected_finance_files_per_month IS
    'E-336 (ID 172) — of the dealer''s monthly customers, how many buy on a loan. Internal; replaces the Customer finance Yes / No.';
