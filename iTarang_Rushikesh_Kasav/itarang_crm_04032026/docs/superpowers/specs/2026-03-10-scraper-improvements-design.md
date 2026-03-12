# Dealer Lead Scraper Improvements — Design Spec

**Date:** 2026-03-10
**Approach:** Firecrawl++ (enhance existing system, no new dependencies)

## Overview

Six incremental improvements to the existing Firecrawl-based dealer lead scraper. Each feature is additive — no rewriting of existing working code.

```
┌─────────────────────────────────────────────────┐
│              Sales Head Scraper UI              │
├──────────┬──────────┬──────────┬────────────────┤
│ Query    │ Schedule │ Deep     │ Lead           │
│ Manager  │ Config   │ Crawl    │ Conversion     │
├──────────┴──────────┴──────────┴────────────────┤
│              Enhanced Scraper Engine            │
│  ┌────────────┐ ┌────────────┐ ┌─────────────┐ │
│  │ Search API │ │ Crawl/Map  │ │ Enrichment  │ │
│  │ (existing) │ │ (new)      │ │ Pipeline    │ │
│  └────────────┘ └────────────┘ └─────────────┘ │
├─────────────────────────────────────────────────┤
│              Firecrawl API (v4)                 │
└─────────────────────────────────────────────────┘
```

---

## Feature 1: Configurable Search Queries

### New DB Table: `scraper_search_queries`
- `id` (VARCHAR PK)
- `query_text` (TEXT, not null)
- `category` (VARCHAR — "search" | "crawl_target")
- `is_active` (BOOLEAN, default true)
- `created_by` (UUID, FK to users)
- `created_at` (TIMESTAMP)

Seeded with the 5 existing hardcoded queries on migration.

### UI Changes
- New "Manage Queries" tab on sales head scraper page
- Table of queries with toggle (active/inactive), edit, delete
- "Add Query" form — text input + category dropdown

### API
- `GET /api/scraper/queries` — list all queries
- `POST /api/scraper/queries` — add new query
- `PATCH /api/scraper/queries/[id]` — edit/toggle active
- `DELETE /api/scraper/queries/[id]` — remove query

### Engine Change
`firecrawl.ts` reads queries from DB instead of hardcoded array. Fallback to hardcoded if no DB queries exist.

---

## Feature 2: Smart Search (Deep Directory Crawling)

User experience stays simple — enter queries, click run, get results. Under the hood:

1. Run search query via Firecrawl `/search` (as today)
2. Check if any result URLs are from known directories (justdial.com, indiamart.com, sulekha.com, tradeindia.com, exportersindia.com, google.com/maps)
3. If yes, scrape those pages deeper using Firecrawl `/scrape` for additional dealer listings
4. Dedup everything as usual

Known directory domains stored as a config array in code. No new tables needed.

---

## Feature 3: Lead Conversion

### Flow
- Sales manager marks a scraped lead as "explored" (interested)
- "Convert to Lead" button appears
- Opens existing lead creation form (`/dealer-portal/leads/new`), pre-filled with scraped data (name, phone, city, state)
- On save, `converted_lead_id` is set on the scraped lead
- Converted leads show a badge + link to the CRM lead

### Changes
- "Convert to Lead" button on explored leads (both views)
- Pre-fill via URL query params (`/leads/new?from_scraped=SDL-xxx`)
- PATCH `converted_lead_id` on existing status endpoint
- Filter option to hide already-converted leads

No new tables or APIs.

---

## Feature 4: Data Enrichment

Automatic enrichment during scraper run, no external API calls.

### Enrichment Steps
1. **Phone validation** — check 10-digit format, flag invalid
2. **City/State normalization** — standardize names ("Blr" → "Bengaluru", "DL" → "Delhi") via lookup map
3. **Lead quality score** — 1-5 based on completeness:
   - Has phone: +1
   - Has city: +1
   - Has dealer name (not generic): +1
   - Has source URL: +1
   - Has address/state: +1

### New Columns on `scraped_dealer_leads`
- `quality_score` (INTEGER)
- `phone_valid` (BOOLEAN)

### UI Changes
- Quality score badge on each lead
- Sort/filter by quality score
- Warning icon on invalid phone leads

---

## Feature 5: Scheduled Runs

### New DB Table: `scraper_schedules`
- `id` (VARCHAR PK)
- `frequency` (VARCHAR — "every_2_days" | "weekly" | "biweekly" | "monthly")
- `day_of_week` (INTEGER, for weekly)
- `time_of_day` (VARCHAR, e.g., "03:00")
- `is_active` (BOOLEAN)
- `created_by` (UUID, FK to users)
- `updated_at` (TIMESTAMP)

Only one active schedule at a time.

### UI Changes
- "Schedule" card on scraper dashboard
- Dropdown: Off / Every 2 Days / Weekly / Biweekly / Monthly
- Time picker
- Day picker (for weekly/biweekly)
- Shows next scheduled run time

### Execution
- Vercel Cron Job: `GET /api/scraper/cron` every 25 hours
- Cron endpoint checks if a run is due based on active schedule
- If due, triggers `runDealerScraper()`
- Skips if a run is already in progress

```json
{ "path": "/api/scraper/cron", "schedule": "0 */25 * * *" }
```

Note: Minimum frequency is every 2 days (Vercel constraint).

---

## Feature 6: Better Extraction

### New Optional Columns on `scraped_dealer_leads`
- `email` (VARCHAR)
- `gst_number` (VARCHAR)
- `business_type` (VARCHAR — distributor, dealer, wholesaler, retailer)
- `products_sold` (TEXT)
- `website` (VARCHAR)

### Change
Update Zod extraction schema in `firecrawl.ts` to request these fields from Firecrawl's AI extraction.

### UI Changes
- Expanded lead detail view showing all available fields
- Fields only shown when data exists

---

## Implementation Order

| # | Feature | New Tables | Complexity |
|---|---------|-----------|------------|
| 1 | Configurable Queries | `scraper_search_queries` | Medium |
| 2 | Smart Search | None | Medium |
| 3 | Lead Conversion | None | Low |
| 4 | Data Enrichment | None (new columns) | Low |
| 5 | Scheduled Runs | `scraper_schedules` | Medium |
| 6 | Better Extraction | None (new columns) | Low |
