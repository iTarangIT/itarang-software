-- Migration: Dealer Lead Scraper Module
-- Created: 2026-03-10

-- scraper_runs: tracks every scraper invocation
CREATE TABLE IF NOT EXISTS scraper_runs (
    id VARCHAR(255) PRIMARY KEY,                              -- SCRAPE-YYYYMMDD-SEQ
    triggered_by UUID NOT NULL REFERENCES users(id),
    status VARCHAR(20) NOT NULL DEFAULT 'running',           -- running, completed, failed, cancelled
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    search_queries JSONB,                                    -- string[] of queries used
    total_found INTEGER DEFAULT 0,
    new_leads_saved INTEGER DEFAULT 0,
    duplicates_skipped INTEGER DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS scraper_runs_status_idx ON scraper_runs(status);
CREATE INDEX IF NOT EXISTS scraper_runs_triggered_by_idx ON scraper_runs(triggered_by);

-- scraped_dealer_leads: individual dealer leads found by the scraper
CREATE TABLE IF NOT EXISTS scraped_dealer_leads (
    id VARCHAR(255) PRIMARY KEY,                              -- SDL-YYYYMMDD-SEQ
    scraper_run_id VARCHAR(255) NOT NULL REFERENCES scraper_runs(id),
    dealer_name TEXT NOT NULL,
    phone VARCHAR(20),
    location_city VARCHAR(100),
    location_state VARCHAR(100),
    source_url TEXT,
    raw_data JSONB,
    -- Assignment (Sales Head assigns to Sales Manager)
    assigned_to UUID REFERENCES users(id),                   -- NULL = unassigned
    assigned_by UUID REFERENCES users(id),
    assigned_at TIMESTAMPTZ,
    -- Exploration workflow
    exploration_status VARCHAR(30) NOT NULL DEFAULT 'unassigned', -- unassigned, assigned, exploring, explored, not_interested
    exploration_notes TEXT,
    explored_at TIMESTAMPTZ,
    -- Optional promotion to full CRM lead
    converted_lead_id VARCHAR(255) REFERENCES leads(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sdl_phone_idx ON scraped_dealer_leads(phone);
CREATE INDEX IF NOT EXISTS sdl_name_city_idx ON scraped_dealer_leads(dealer_name, location_city);
CREATE INDEX IF NOT EXISTS sdl_source_url_idx ON scraped_dealer_leads(source_url);
CREATE INDEX IF NOT EXISTS sdl_run_idx ON scraped_dealer_leads(scraper_run_id);
CREATE INDEX IF NOT EXISTS sdl_assigned_to_idx ON scraped_dealer_leads(assigned_to);
CREATE INDEX IF NOT EXISTS sdl_status_idx ON scraped_dealer_leads(exploration_status);

-- scraper_dedup_logs: audit trail for skipped duplicate entries
CREATE TABLE IF NOT EXISTS scraper_dedup_logs (
    id VARCHAR(255) PRIMARY KEY,                              -- DDUP-YYYYMMDD-SEQ
    scraper_run_id VARCHAR(255) NOT NULL REFERENCES scraper_runs(id),
    raw_dealer_name TEXT,
    raw_phone VARCHAR(20),
    raw_location TEXT,
    raw_source_url TEXT,
    skip_reason VARCHAR(50) NOT NULL,                        -- duplicate_phone, duplicate_name_location, duplicate_url
    matched_lead_id VARCHAR(255),                            -- existing SDL id that matched
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ddup_run_idx ON scraper_dedup_logs(scraper_run_id);
