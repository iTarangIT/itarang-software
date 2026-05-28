-- E-123: interest_level_overrides — audit of manual interest_level changes
--
-- BRD §0.7. interest_level on dealer_leads is independent of lead_status.
-- AI score sets a default (hot/warm/cold), but owner can override with a
-- mandatory reason — every override lands here for audit + the
-- "AI Score Accuracy" report (BRD §0.11 Report 4).

CREATE TABLE IF NOT EXISTS interest_level_overrides (
  override_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_lead_id text NOT NULL,
  from_value varchar(20),
  to_value varchar(20) NOT NULL,
  reason text NOT NULL,
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS interest_level_overrides_lead_changed_idx
  ON interest_level_overrides (dealer_lead_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS interest_level_overrides_changer_idx
  ON interest_level_overrides (changed_by, changed_at DESC);
