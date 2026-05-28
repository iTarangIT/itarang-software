-- E-121: holiday_calendar — admin-maintained holiday list
--
-- BRD §0.1 Glossary. Working day = Mon–Sat excluding entries in this table.
-- Used for first-touch SLA (9 AM – 7 PM IST) and the 5/10/14 working-day
-- stale-lead visual cues (BRD §0.5).

CREATE TABLE IF NOT EXISTS holiday_calendar (
  holiday_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holiday_date date NOT NULL,
  holiday_name varchar(200) NOT NULL,
  is_active boolean DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS holiday_calendar_date_uniq
  ON holiday_calendar (holiday_date);

CREATE INDEX IF NOT EXISTS holiday_calendar_active_idx
  ON holiday_calendar (is_active, holiday_date)
  WHERE is_active = true;
