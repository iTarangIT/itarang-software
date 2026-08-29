------------------------------------------------------------------------------
-- E-212 — retune the vendor credit-balance alert thresholds.
--
-- vendor.credits_remaining was seeded at warn 20,000 / crit 5,000. ElevenLabs
-- (the only vendor that reports a credit balance) burnt ~115k credits in its
-- peak month against a ~253k quota — about 3.8k/day. That made the old
-- thresholds worth ~5 days and ~1.3 days of runway respectively, which is not
-- enough notice to get a plan topped up before calls start failing.
--
-- New values: warn 40,000 (~10 days), crit 15,000 (~4 days). Mirrored in
-- src/lib/operations/registry.ts, which is what seeds a fresh environment.
--
-- WHY THIS FILE EXISTS AT ALL. seedAlertRules() inserts with
-- ON CONFLICT DO NOTHING, deliberately: a threshold someone tuned by hand must
-- survive a deploy. That means changing the registry default does NOT move an
-- existing row, so environments already carrying the old seed need this UPDATE.
--
-- AND WHY IT IS CONDITIONAL. The WHERE clause matches only rows still holding
-- the exact old seeded pair. If someone has already tuned this threshold by
-- hand, the row does not match and is left alone — the same guarantee the
-- ON CONFLICT DO NOTHING gives, preserved here rather than overridden.
-- Idempotent as a side effect: a second run matches nothing.
--
-- Data-only. No DDL, no table, no column, no type change.
------------------------------------------------------------------------------

DO $do$ BEGIN
  UPDATE ops_alert_rules
     SET warn_threshold = 40000,
         crit_threshold = 15000,
         updated_at     = NOW()
   WHERE metric_key     = 'vendor.credits_remaining'
     AND source         = '*'
     -- Only if untouched since seeding. numeric(20,4) compares fine to an
     -- integer literal here; no cast needed.
     AND warn_threshold = 20000
     AND crit_threshold = 5000;
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'skip ops_alert_rules — apply E-210 first';
END; $do$;
