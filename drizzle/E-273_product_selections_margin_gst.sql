-- E-273: GST on the dealer margin (product_selections)
--
-- Pricing rule: every rupee of dealer margin/commission is itself taxable at
-- 18%. From this migration on:
--   dealer_margin_gst_amount = round(dealer_margin * dealer_margin_gst_percent / 100)
--   final_price              = net_subtotal + dealer_margin + dealer_margin_gst_amount
--
-- Rows written before E-273 keep NULL here (read as 0). Their final_price was
-- what the customer approved over OTP and is deliberately NOT recomputed.
--
-- REQUIRED before the code deploys: profile-export, the product-selection draft
-- route and the NBFC lead page do bare db.select().from(product_selections),
-- which names every mirrored column.
--
-- Idempotent and additive. Re-running is a no-op.

ALTER TABLE product_selections
  ADD COLUMN IF NOT EXISTS dealer_margin_gst_percent numeric(5,2);

ALTER TABLE product_selections
  ADD COLUMN IF NOT EXISTS dealer_margin_gst_amount numeric(12,2);

COMMENT ON COLUMN product_selections.dealer_margin_gst_amount IS
  'E-273: GST charged on dealer_margin. final_price = net_subtotal + dealer_margin + dealer_margin_gst_amount. NULL before E-273 = 0.';
COMMENT ON COLUMN product_selections.dealer_margin_gst_percent IS
  'E-273: GST rate applied to dealer_margin at submit time (18).';
