-- E-390 — Battery Pool diagram 1: iTarang Admin checks the dealer assignment
-- before a file can be routed to an NBFC (19 Nov 2026).
--
-- An "uncertain" application (dealer picked by an iTarang salesperson from the
-- dealers he owns, pushed by the iTarang House admin, or created by a dealer
-- sales-team member) is held with leads.assignment_status = 'pending_verification'
-- (existing varchar(24), no CHECK — no column change) until an iTarang admin
-- approves, changes or rejects the dealer. One row per check:
--
--   lead_dealer_reviews      — proposed dealer, why it needs a check, who started
--                              it (channel, user / WhatsApp number), decision.
--   house_login_staff_links  — which iTarang sales person uses each iTarang House
--                              team login (so Step 1 can list the dealers he owns).
--
-- Strictly additive + idempotent.

CREATE TABLE IF NOT EXISTS lead_dealer_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id varchar(50) NOT NULL,
  dealer_id varchar(255) NOT NULL,
  reason_kind varchar(24) NOT NULL,
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  channel varchar(12) NOT NULL DEFAULT 'web',
  initiated_by_user_id uuid,
  initiated_by_name text,
  initiator_wa_phone varchar(20),
  status varchar(16) NOT NULL DEFAULT 'pending',
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text,
  final_dealer_id varchar(255),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_dealer_reviews_status_chk CHECK (status IN ('pending', 'approved', 'changed', 'rejected'))
);

CREATE INDEX IF NOT EXISTS lead_dealer_reviews_lead_idx
  ON lead_dealer_reviews (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lead_dealer_reviews_status_idx
  ON lead_dealer_reviews (status, created_at DESC);
-- At most one open check per lead.
CREATE UNIQUE INDEX IF NOT EXISTS lead_dealer_reviews_one_pending_uniq
  ON lead_dealer_reviews (lead_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS house_login_staff_links (
  login_user_id uuid PRIMARY KEY,
  staff_user_id uuid NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS house_login_staff_links_staff_idx
  ON house_login_staff_links (staff_user_id);
