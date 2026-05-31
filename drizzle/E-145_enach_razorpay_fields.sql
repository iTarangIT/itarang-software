-- E-145 — BRD Addendum V0.2 §9 (E-NACH), "iTarang Razorpay (managed)" variant.
--
-- Adds the Razorpay handles to enach_mandates so iTarang can create + track the
-- e-mandate itself (Orders + Tokens) instead of only handing off B2-B. The
-- canonical `status` still drives every gate (§9.3); these columns are operational
-- correlation handles + raw provider data. The signature-verified Razorpay webhook
-- (/api/payments/razorpay/emandate-webhook) flips `status` to registered/failed.
--
-- Strictly additive + idempotent.

ALTER TABLE "enach_mandates"
  ADD COLUMN IF NOT EXISTS "razorpay_order_id"    varchar(64);
ALTER TABLE "enach_mandates"
  ADD COLUMN IF NOT EXISTS "razorpay_customer_id" varchar(64);
ALTER TABLE "enach_mandates"
  ADD COLUMN IF NOT EXISTS "razorpay_token_id"    varchar(64);

CREATE INDEX IF NOT EXISTS "enach_mandates_rzp_order_idx"
  ON "enach_mandates" ("razorpay_order_id");

-- E-134 created a CHECK allowing registration_method IN ('callback','manual').
-- The managed Razorpay path records results via the Razorpay webhook, so widen
-- the allowed set to include 'razorpay'. Drop + recreate idempotently.
DO $do$ BEGIN
  ALTER TABLE "enach_mandates" DROP CONSTRAINT IF EXISTS "enach_mandates_method_check";
  ALTER TABLE "enach_mandates"
    ADD CONSTRAINT "enach_mandates_method_check"
    CHECK ("registration_method" IS NULL
           OR "registration_method" IN ('callback', 'manual', 'razorpay'));
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'skip: enach_mandates missing';
END; $do$;

COMMENT ON COLUMN "enach_mandates"."razorpay_token_id" IS
  'Razorpay recurring token id — the registered e-mandate handle (managed variant, §9).';
