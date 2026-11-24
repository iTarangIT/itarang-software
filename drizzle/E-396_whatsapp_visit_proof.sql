-- migration-gate: held
-- =============================================================================
-- E-396 — WhatsApp visit proof (24 Nov 2026).
--
-- A completed visit logged from the WhatsApp Assistant now takes its proof
-- inside WhatsApp: the ASM sends their location pin (WhatsApp "Send location")
-- and then takes the shop photo in a camera-only WhatsApp Flow form. Same
-- visit_captures row as the CRM capture page (ID 196 / E-363), with:
--
--   source           'crm' (the visit form) or 'whatsapp' (the Assistant).
--   shop_distance_m  how far the pin was from the shop's known position when
--                    one was known; NULL = no position yet (first visit).
--   gps_accuracy_m   DROP NOT NULL (widening only): a WhatsApp pin carries no
--                    accuracy. CRM captures still always fill it.
--
-- NOT mirrored in schema.ts — raw SQL behind a probe
-- (src/lib/visits/verifiedStore.ts hasWhatsAppVisitProof). Before this file is
-- applied a completed visit from WhatsApp gets the CRM capture link, as today.
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

DO $do$
BEGIN
    ALTER TABLE visit_captures ADD COLUMN IF NOT EXISTS source varchar(20) NOT NULL DEFAULT 'crm';
    ALTER TABLE visit_captures ADD COLUMN IF NOT EXISTS shop_distance_m numeric(10, 1);
    ALTER TABLE visit_captures ALTER COLUMN gps_accuracy_m DROP NOT NULL;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'skip: visit_captures missing — apply E-363 first';
END;
$do$;
