-- E-398 — LinkedIn Outreach: campaign categories + meetings (27 Nov 2026).
--
-- Sales Head asks: track campaigns by category (3 Wheeler, 2 Wheeler, FinTech…)
-- and show Approached → Accepted → Replied → Meeting scheduled; export it.
--
-- NEW TABLES ONLY (no column on an existing li_* table), so an environment
-- without this file keeps every E-393 screen working: the code probes
-- to_regclass('public.li_meetings') and simply hides categories / meetings
-- until it is applied (src/lib/linkedin/services/extras.ts).
--
--   li_campaign_categories  one category per campaign (fixed list in src/lib/linkedin/categories.ts)
--   li_meetings             a campaign row the Sales Head marked "meeting scheduled" (manual — the KPI)
--   li_meeting_hints        the reply-draft AI thinks a meeting was agreed (a nudge only, never counted)
--
-- Strictly additive + idempotent.

CREATE TABLE IF NOT EXISTS li_campaign_categories (
  campaign_id uuid PRIMARY KEY,
  category varchar(24) NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS li_campaign_categories_cat_idx ON li_campaign_categories (category);

CREATE TABLE IF NOT EXISTS li_meetings (
  campaign_prospect_id uuid PRIMARY KEY,
  conversation_id uuid,
  marked_by uuid,
  marked_at timestamptz NOT NULL DEFAULT now(),
  note text
);
CREATE INDEX IF NOT EXISTS li_meetings_marked_idx ON li_meetings (marked_at);

CREATE TABLE IF NOT EXISTS li_meeting_hints (
  conversation_id uuid PRIMARY KEY,
  detected_at timestamptz NOT NULL DEFAULT now(),
  dismissed_at timestamptz
);
