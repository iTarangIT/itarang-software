-- E-106 — region hierarchy on dealer_leads + org-wide region_groups.
--
-- Replaces the flat `dealer_leads.location` text dropdown with a structured
-- state → city → (area / pincode) hierarchy used by the AI dialer's region
-- selector and saved region groups. Additive only: `location` stays so older
-- callers (and the legacy /api/dealer-leads/locations endpoint) keep working
-- during the transition. New write paths populate both shapes; backfill
-- script `scripts/backfill-dealer-leads-region.ts` fills history.
--
-- Idempotent. Re-running this file is a no-op.

ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS state    text;
ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS city     text;
ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS area     text;
ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS pincode  text;
ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS country  text DEFAULT 'IN';
ALTER TABLE dealer_leads ADD COLUMN IF NOT EXISTS timezone text;
-- preferred_language reuses the existing dealer_leads.language column.

-- Region tree endpoint (/api/dealer-leads/regions/tree) groups by state, city.
CREATE INDEX IF NOT EXISTS idx_dealer_leads_state_city
    ON dealer_leads (state, city);

-- Optional pincode drill-down. Partial index keeps the index small since
-- most rows will have a NULL pincode until backfill / re-scrape lands.
CREATE INDEX IF NOT EXISTS idx_dealer_leads_pincode
    ON dealer_leads (pincode) WHERE pincode IS NOT NULL;

-- Hot path used by /api/ai-dialer/preview: filter by region + segment, with
-- only callable rows. Matches the WHERE clause exactly so the planner can
-- index-only scan instead of seqscan on multi-region selections.
CREATE INDEX IF NOT EXISTS idx_dealer_leads_callable_region
    ON dealer_leads (state, city, current_status)
    WHERE phone IS NOT NULL AND phone <> '';

-- Org-wide saved region groups. JSONB shape:
--   [ { "state": "Uttar Pradesh", "cities": ["Ghaziabad","Noida"] }, ... ]
-- An empty `cities` array means "all cities currently in that state" —
-- resolved at preview time, not stored, so newly-scraped cities are
-- automatically picked up by existing groups.
CREATE TABLE IF NOT EXISTS region_groups (
    id           text PRIMARY KEY,
    name         text NOT NULL,
    description  text,
    regions      jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_by   text,
    created_at   timestamp DEFAULT now(),
    updated_at   timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_region_groups_name ON region_groups (name);

-- Seed two groups so the modal isn't empty on first open.
INSERT INTO region_groups (id, name, description, regions)
VALUES
    ('rg_delhi_ncr',  'Delhi NCR',
     'Delhi + adjacent NCR cities across UP & Haryana',
     '[{"state":"Delhi","cities":[]},
       {"state":"Uttar Pradesh","cities":["Ghaziabad","Noida"]},
       {"state":"Haryana","cities":["Gurgaon","Faridabad"]}]'::jsonb),
    ('rg_mumbai_zone','Mumbai Zone',
     'MMR core',
     '[{"state":"Maharashtra","cities":["Mumbai","Thane","Navi Mumbai"]}]'::jsonb)
ON CONFLICT (id) DO NOTHING;
