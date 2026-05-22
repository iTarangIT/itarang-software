-- E-113: lead_touchpoints — per-interaction history
--
-- The canonical audit row for everything that happens to a dealer_lead:
-- AI calls, manual calls, WhatsApp, brochures, status changes, escalations,
-- reactivations. BRD §0.13 full schema; touchpoint_type enum (22 values)
-- lives in src/lib/lifecycle/touchpointTypes.ts.
--
-- Single writer in src/lib/touchpoints/write.ts — every mutate path goes
-- through it so the BRD §0.11 "Status Changes Without Same-Hour Touchpoint"
-- compliance KPI stays meaningful.

CREATE TABLE IF NOT EXISTS lead_touchpoints (
  touchpoint_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_lead_id text NOT NULL,
  touchpoint_type varchar(50) NOT NULL,
  performed_by text,
  performed_at timestamptz NOT NULL,
  call_status varchar(30),
  call_duration_sec integer,
  is_engaged boolean DEFAULT false,
  remarks text,
  attachments jsonb DEFAULT '[]'::jsonb,
  next_action varchar(50),
  next_action_at timestamptz,
  external_system varchar(50),
  external_event_id text,
  sync_method varchar(30) DEFAULT 'manual',
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);

-- Drives the touchpoint history pane in Lead Detail (BRD §0.5)
CREATE INDEX IF NOT EXISTS lead_touchpoints_lead_perf_idx
  ON lead_touchpoints (dealer_lead_id, performed_at DESC);

-- Drives reports (Daily Activity, Lead Funnel — BRD §0.11)
CREATE INDEX IF NOT EXISTS lead_touchpoints_type_call_idx
  ON lead_touchpoints (touchpoint_type, call_status);

-- Idempotency guard for future V1.1 external-system sync (NeoDove / Interakt)
CREATE UNIQUE INDEX IF NOT EXISTS lead_touchpoints_external_uniq
  ON lead_touchpoints (external_system, external_event_id)
  WHERE external_event_id IS NOT NULL;

-- Performer-grouped queries for Daily Activity report
CREATE INDEX IF NOT EXISTS lead_touchpoints_performer_idx
  ON lead_touchpoints (performed_by, performed_at DESC)
  WHERE performed_by IS NOT NULL;
