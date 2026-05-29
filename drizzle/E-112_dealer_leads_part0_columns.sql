-- E-112: Part 0 BRD additions to dealer_leads
--
-- Adds the lifecycle / ownership / escalation / audit columns required by
-- the Inside Sales workflow (BRD §0.13). Strictly additive and idempotent.
--
-- Notes:
--   * No native PG enums — varchar() with TS-side validation, matching
--     project convention (see CLAUDE.md). The 9-status enum lives in
--     src/lib/lifecycle/transitions.ts.
--   * dealer_leads.id is text — every FK column uses text to match.
--     last_escalation_id / upload_batch_id / dealer_onboarding_application_id
--     point at uuid PKs and are stored as uuid here.
--   * Existing assigned_to column is preserved (legacy); current_owner_id is
--     the new authoritative owner per BRD §0.3.
--   * updated_at is added so the concurrency-banner helper (BRD §0.3) has a
--     monotonic field to compare against.

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'dealer_leads') THEN
    RAISE NOTICE 'dealer_leads table missing; skipping E-112';
    RETURN;
  END IF;

  -- Lifecycle / status
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS lead_status varchar(50);
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS ai_recall_status varchar(30);
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS lost_reason varchar(100);
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS lost_reason_notes text;
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS previous_lost_reason varchar(100);
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS onboarding_dropout_reason varchar(50);
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS onboarding_dropout_notes text;
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS interest_level varchar(20);
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS preliminary_payment_intent text;
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS pre_transfer_status varchar(50);
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS brochure_sent_at timestamptz;

  -- Ownership / attribution (BRD §0.3)
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS originator_id text;
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS current_owner_id text;
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS closing_owner_id text;
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS closing_role varchar(50);
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS ai_session_id text;
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS asm_id text;
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS assigned_at timestamptz;
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS closed_at timestamptz;
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS last_touchpoint_at timestamptz;
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS next_follow_up_at timestamptz;
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT NOW();

  -- Escalation (BRD §0.6)
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS escalation_status varchar(30);
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS escalation_count integer DEFAULT 0;
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS last_escalation_id uuid;

  -- Cross-table links (BRD §0.4, §0.11)
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS upload_batch_id uuid;
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS dealer_onboarding_application_id uuid;

  -- Business profile (BRD §0.4)
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS segments jsonb DEFAULT '[]'::jsonb;
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS address_history jsonb DEFAULT '[]'::jsonb;
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS address_notes text;

  -- Soft delete (BRD §0.13)
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;
  ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
END
$do$;

-- Indexes per BRD §0.13
CREATE INDEX IF NOT EXISTS dealer_leads_lead_status_owner_idx
  ON dealer_leads (lead_status, current_owner_id);

CREATE INDEX IF NOT EXISTS dealer_leads_owner_follow_up_idx
  ON dealer_leads (current_owner_id, next_follow_up_at)
  WHERE next_follow_up_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS dealer_leads_escalation_pending_idx
  ON dealer_leads (escalation_status)
  WHERE escalation_status = 'pending_review';

CREATE INDEX IF NOT EXISTS dealer_leads_is_active_idx
  ON dealer_leads (is_active)
  WHERE is_active = true;
