-- E-114: lead_visits — ASM ground visits
--
-- BRD §0.8 + §0.13. ASM logs every visit (scheduled / attempted / completed).
-- A parallel row is written to lead_touchpoints (touchpoint_type='visit') so
-- the unified history pane shows visits inline.

CREATE TABLE IF NOT EXISTS lead_visits (
  visit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_lead_id text NOT NULL,
  asm_id text NOT NULL,
  scheduled_date date,
  actual_visit_date date,
  visit_status varchar(30) NOT NULL,
  visit_outcome varchar(30),
  visit_remarks text,
  photos jsonb DEFAULT '[]'::jsonb,
  gps_check_in_lat numeric(10, 6),
  gps_check_in_lng numeric(10, 6),
  next_action varchar(30),
  next_visit_date date,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS lead_visits_lead_sched_idx
  ON lead_visits (dealer_lead_id, scheduled_date);

CREATE INDEX IF NOT EXISTS lead_visits_asm_status_idx
  ON lead_visits (asm_id, visit_status);
