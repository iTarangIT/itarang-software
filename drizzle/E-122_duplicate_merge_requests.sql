-- E-122: duplicate_merge_requests — phone collisions + address mismatches
--
-- BRD §0.4. Captures three request types:
--   * phone_collision_manual_edit   — rep tried to edit phone to one that exists
--   * address_mismatch_upload       — bulk upload phone matched but address differs
--   * address_mismatch_ai_dialer    — AI re-scrape changed address on existing lead
--
-- V1 admin handles the actual merge manually outside the system — this table
-- tracks the request, the admin's decision, and the resolution narrative.

CREATE TABLE IF NOT EXISTS duplicate_merge_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_type varchar(50) NOT NULL,
  source_lead_id text,
  target_lead_id text NOT NULL,
  requested_by text,
  request_notes text,
  status varchar(30) NOT NULL DEFAULT 'pending',
  resolution_action varchar(50),
  admin_resolution_notes text,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);

-- Admin queue ordering: pending first, newest pending highest
CREATE INDEX IF NOT EXISTS duplicate_merge_requests_status_created_idx
  ON duplicate_merge_requests (status, created_at DESC);

-- Reverse lookup: every merge request affecting a given lead
CREATE INDEX IF NOT EXISTS duplicate_merge_requests_target_idx
  ON duplicate_merge_requests (target_lead_id);
