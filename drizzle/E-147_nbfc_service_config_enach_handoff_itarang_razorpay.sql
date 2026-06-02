-- E-147 — Widen the nbfc_service_config E-NACH handoff CHECK to allow the
-- managed-Razorpay mode. E-133 created the constraint allowing only the two
-- B2-B handoff modes ('redirect', 'webhook'); the later managed Razorpay
-- e-mandate rail (Addendum V0.2 §9 Model B2-B, see E-145) added a third mode,
-- 'itarang_razorpay', which the Service Opt-In route already accepts. Saving a
-- config with that mode currently fails the stale constraint.
--
-- Idempotent: drop the old constraint if present, then re-add the widened one.

DO $do$ BEGIN
  ALTER TABLE "nbfc_service_config"
    DROP CONSTRAINT IF EXISTS "nbfc_service_config_enach_handoff_check";
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'skip: nbfc_service_config table absent';
END; $do$;

DO $do$ BEGIN
  ALTER TABLE "nbfc_service_config"
    ADD CONSTRAINT "nbfc_service_config_enach_handoff_check"
    CHECK ("enach_handoff_method" IS NULL
           OR "enach_handoff_method" IN ('redirect', 'webhook', 'itarang_razorpay'));
EXCEPTION
  WHEN duplicate_object THEN RAISE NOTICE 'skip: nbfc_service_config_enach_handoff_check exists';
  WHEN undefined_table THEN RAISE NOTICE 'skip: nbfc_service_config table absent';
END; $do$;
