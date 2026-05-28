-- E-120: assignment_config — single-row admin-tunable config
--
-- BRD §0.2 (intent threshold) + §0.1 (working-day calendar). One row only.
-- Seeded with BRD defaults: intent threshold 60, working hours 09:00-19:00 IST,
-- Mon-Sat working days.

CREATE TABLE IF NOT EXISTS assignment_config (
  config_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_score_threshold integer DEFAULT 60,
  working_hours_start varchar(8) DEFAULT '09:00',
  working_hours_end varchar(8) DEFAULT '19:00',
  working_days jsonb DEFAULT '["mon","tue","wed","thu","fri","sat"]'::jsonb,
  updated_by text,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);

-- Seed the single config row if not present
INSERT INTO assignment_config (intent_score_threshold, working_hours_start, working_hours_end, working_days)
SELECT 60, '09:00', '19:00', '["mon","tue","wed","thu","fri","sat"]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM assignment_config);
