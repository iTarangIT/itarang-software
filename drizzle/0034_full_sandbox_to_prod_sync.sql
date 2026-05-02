-- Auto-generated full schema sync: sandbox → prod
-- Strategy: additive only. No DROPs. Idempotent (IF NOT EXISTS).
-- Generated: 2026-04-25T09:04:09.874Z
-- Source: sandbox (73 tables)  Target: prod (77 tables)

-- ── Sequences ───────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS "lead_reference_seq" AS bigint START WITH 89 INCREMENT BY 1;

-- ── Indexes (2) ─────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_scraper_leads_phone ON scraper_leads USING btree (phone) WHERE ((phone IS NOT NULL) AND (phone <> ''::text));
CREATE UNIQUE INDEX IF NOT EXISTS idx_scraper_leads_website ON scraper_leads USING btree (website) WHERE ((website IS NOT NULL) AND (website <> ''::text));
