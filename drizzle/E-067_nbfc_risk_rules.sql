-- E-067 — Risk Rule Engine threshold configuration with impact preview
-- BRD §6.3.3
--
-- Single canonical platform-wide table holding the eight tunable risk
-- thresholds that drive CDS bands, alert triggers, and action gates.
--
-- The table is named `nbfc_risk_rules` (matches the BRD-extract YAML and
-- avoids colliding with E-085's `nbfc_risk_rule_thresholds` audit log, which
-- stores the append-only history of approval-gated mutations rather than the
-- current tunable value). This unit OWNS the canonical current-value table;
-- E-085 reads `current_value` from here on the GET side and writes back to
-- it after the dual-approval gate fires.
--
-- IMPORTANT: rule_key is UNIQUE so impact-preview lookups by key are O(1)
-- and we never end up with duplicate threshold rows.

CREATE TABLE IF NOT EXISTS "nbfc_risk_rules" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "rule_key"       varchar(64) NOT NULL UNIQUE,
  "rule_label"     varchar(160) NOT NULL,
  "current_value"  numeric(12, 4) NOT NULL,
  "unit"           varchar(16),
  "updated_at"     timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by"     uuid
);

-- Seed the eight canonical platform thresholds. ON CONFLICT DO NOTHING so this
-- migration is idempotent across re-runs and so the seed never overwrites a
-- value that was already tuned via the admin UI.
INSERT INTO "nbfc_risk_rules"
  ("rule_key",            "rule_label",                       "current_value", "unit")
VALUES
  ('cds_low_medium',      'CDS: Low/Medium threshold',         40,    'score'),
  ('cds_medium_high',     'CDS: Medium/High threshold',        70,    'score'),
  ('cds_high_very_high',  'CDS: High/Very High threshold',     85,    'score'),
  ('emi_overdue_days',    'EMI Overdue Trigger',               30,    'days'),
  ('usage_drop_pct',      'Usage Drop Threshold',              40,    'pct'),
  ('geo_shift_km',        'Geo-Shift Threshold',               100,   'km'),
  ('offline_alert_hours', 'Offline Alert Threshold',           24,    'hours'),
  ('pci_concern',         'PCI: Concern threshold',            0.40,  'score')
ON CONFLICT ("rule_key") DO NOTHING;
