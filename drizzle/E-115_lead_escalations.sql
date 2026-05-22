-- E-115: lead_escalations — escalation events + resolution
--
-- BRD §0.6 + §0.13. Raised by any current owner (IS Rep or ASM). Resolved
-- ONLY by admin (Reassign / Return-with-guidance / No-Action). CEO can
-- comment + recommend but does NOT execute (split RBAC, BRD §0.12).
--
-- ceo_comment / ceo_recommendation are denormalised latest values — the
-- full thread lives in lead_touchpoints (escalation_ceo_comment / *_recommendation).

CREATE TABLE IF NOT EXISTS lead_escalations (
  escalation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_lead_id text NOT NULL,
  raised_by text NOT NULL,
  raised_at timestamptz NOT NULL,
  escalation_reason varchar(50) NOT NULL,
  escalation_notes text NOT NULL,
  suggested_action text,
  urgency varchar(20) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'pending_review',
  ceo_comment text,
  ceo_recommendation text,
  ceo_recommended_at timestamptz,
  resolved_by text,
  resolved_at timestamptz,
  resolution_action varchar(30),
  resolution_notes text,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);

-- Admin dashboard "Pending Escalations" panel — sorted by urgency + age
CREATE INDEX IF NOT EXISTS lead_escalations_status_urg_idx
  ON lead_escalations (status, urgency, raised_at);

-- Per-lead escalation history
CREATE INDEX IF NOT EXISTS lead_escalations_lead_raised_idx
  ON lead_escalations (dealer_lead_id, raised_at DESC);
