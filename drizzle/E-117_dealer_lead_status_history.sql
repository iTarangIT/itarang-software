-- E-117: dealer_lead_status_history — full lifecycle audit
--
-- BRD §0.7. Every status change writes a row here, including multiple
-- Lost ↔ Reactivated cycles which previous_lost_reason (display-only) can't
-- capture. Reports query this table, not the denormalised previous_lost_reason
-- field.

CREATE TABLE IF NOT EXISTS dealer_lead_status_history (
  history_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_lead_id text NOT NULL,
  from_status varchar(50),
  to_status varchar(50) NOT NULL,
  from_lost_reason varchar(100),
  to_lost_reason varchar(100),
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL,
  reason_notes text,
  created_at timestamptz DEFAULT NOW()
);

-- Newest-first per-lead view (Lead Detail audit pane)
CREATE INDEX IF NOT EXISTS dealer_lead_status_history_lead_changed_idx
  ON dealer_lead_status_history (dealer_lead_id, changed_at DESC);

-- Reports: BRD §0.11 logging-compliance KPI joins on changed_at window
CREATE INDEX IF NOT EXISTS dealer_lead_status_history_changed_at_idx
  ON dealer_lead_status_history (changed_at);
