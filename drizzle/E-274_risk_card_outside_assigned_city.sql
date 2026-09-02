-- E-274 — "Vehicle outside its assigned city" risk card + its governed radius.
--
-- A new hand-coded risk hypothesis for the NBFC Risk dashboard (/nbfc/risk):
-- a financed vehicle whose latest GPS fix is more than `city_geofence_km` from
-- the centre of the city the loan was written for (the borrower's city on the
-- sanction's lead, else the selling dealer's). Distinct from `geo-shift`, which
-- measures against a LEARNED 30-day home base and therefore follows a diverted
-- asset to its new home; this one measures against a fixed, agreed place.
--
-- Three idempotent steps, no DDL:
--   1. the catalogue row (slug must match HAND_CODED_CARDS in
--      src/lib/risk/hand-coded-cards.ts). source='human' rows are promoted by
--      definition (E-188), so promoted_at is stamped here.
--   2. the ninth governed threshold in nbfc_risk_rules, default 25 km. The admin
--      GET self-heals a missing key too, but seeding it here means the card is
--      judged by the documented default from its first cron run.
--   3. visibility. E-199 is a strict, deliberately UNSEEDED allowlist, so a new
--      card is invisible to every partner until an admin ticks it. Rather than
--      ship a card nobody can see, it is switched on for exactly the tenants an
--      admin has ALREADY given the sibling geo-shift card — the same judgement
--      call, already made. Everyone else gets it through the admin screen.
--
-- Safe to skip at deploy time: nothing in schema.ts names a new column; an
-- environment without this file simply has no such card (the evaluator is only
-- dispatched for a catalogue row that exists) and judges by the 25 km default.
-- Re-running this file is a no-op.

INSERT INTO "risk_hypotheses"
  ("slug", "title", "description", "test_method", "test_definition", "source", "promoted_at")
VALUES (
  'outside-assigned-city',
  'Vehicle outside its assigned city',
  'Vehicles whose latest GPS fix is further than the governed City Geofence Radius from the centre of the city the loan was written for (the borrower''s city, else the selling dealer''s). Unlike geo-shift this measures against a fixed location, so an asset that has relocated stays flagged.',
  'js',
  '{"kind":"hand_coded","fn":"outsideAssignedCity"}',
  'human',
  now()
)
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "nbfc_risk_rules" ("rule_key", "rule_label", "current_value", "unit")
VALUES ('city_geofence_km', 'City Geofence Radius', 25, 'km')
ON CONFLICT ("rule_key") DO NOTHING;

-- Visibility: mirror the geo-shift allowlist. Guarded so a database that never
-- received E-199 raises a notice instead of aborting.
DO $do$
BEGIN
  INSERT INTO "nbfc_risk_card_visibility" ("tenant_id", "hypothesis_id", "updated_by")
  SELECT v.tenant_id, new_h.id, v.updated_by
    FROM "nbfc_risk_card_visibility" v
    JOIN "risk_hypotheses" old_h ON old_h.id = v.hypothesis_id AND old_h.slug = 'geo-shift'
    JOIN "risk_hypotheses" new_h ON new_h.slug = 'outside-assigned-city'
  ON CONFLICT ("tenant_id", "hypothesis_id") DO NOTHING;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'E-274: nbfc_risk_card_visibility missing (E-199 not applied) — skipping visibility seed';
END;
$do$;
