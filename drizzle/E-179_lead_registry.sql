------------------------------------------------------------------------------
-- E-179: Central lead registry — ONE table that records every new lead-like
--        capture across the platform, regardless of type or channel.
--
-- Every time a prospect is first captured anywhere (customer lead via web or
-- WhatsApp, dealer onboarding via web wizard or WhatsApp bot, NBFC onboarding,
-- OEM), a row is appended here with the type, name and phone. The originating
-- record keeps living in its own table (leads, dealer_onboarding_applications,
-- nbfc onboarding, …) — source_table/source_id link back to it. Writes are
-- best-effort from src/lib/leads/lead-registry.ts and never block the main
-- flow. Idempotent + strictly additive.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lead_registry (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  lead_type      VARCHAR(16) NOT NULL,   -- 'dealer' | 'customer' | 'oem' | 'nbfc'
  name           TEXT NOT NULL,          -- person/company name as captured
  phone          VARCHAR(20),            -- as captured; may be NULL for some flows
  source_channel VARCHAR(16) NOT NULL,   -- 'web' | 'whatsapp' | 'admin' | 'scraper'
  source_table   TEXT,                   -- originating table, e.g. 'leads'
  source_id      TEXT                    -- originating row id (text — mixed id types)
);

CREATE INDEX IF NOT EXISTS lead_registry_type_created_idx
  ON lead_registry (lead_type, created_at DESC);
CREATE INDEX IF NOT EXISTS lead_registry_phone_idx
  ON lead_registry (phone);
-- One registry row per originating record — lets the helper be safely
-- re-invoked (retries, double-submits) without duplicating entries.
CREATE UNIQUE INDEX IF NOT EXISTS lead_registry_source_unique
  ON lead_registry (source_table, source_id)
  WHERE source_table IS NOT NULL AND source_id IS NOT NULL;

------------------------------------------------------------------------------
-- Backfill: copy every PRE-EXISTING lead-like record into the registry, with
-- its original created_at. Idempotent — the partial unique index above +
-- ON CONFLICT DO NOTHING make re-runs a no-op. Each block is wrapped so the
-- file still applies on an environment that lacks one of the source tables
-- or columns (the DBs drift).
------------------------------------------------------------------------------

-- Customer leads (web + WhatsApp). Skips never-completed drafts (owner_name
-- 'DRAFT' placeholder). Rows created by the sales-team endpoint carry
-- business fields and are dealer prospects, not customers.
DO $do$ BEGIN
  INSERT INTO lead_registry (created_at, lead_type, name, phone, source_channel, source_table, source_id)
  SELECT
    COALESCE(l.created_at, now()),
    CASE WHEN l.business_name IS NOT NULL OR l.business_type IS NOT NULL THEN 'dealer' ELSE 'customer' END,
    COALESCE(NULLIF(l.full_name, ''), NULLIF(NULLIF(l.owner_name, 'DRAFT'), ''), 'Unknown'),
    LEFT(COALESCE(NULLIF(NULLIF(l.phone, 'DRAFT'), ''), NULLIF(NULLIF(l.owner_contact, 'DRAFT'), ''), NULLIF(l.mobile, '')), 20),
    COALESCE(l.source_channel, 'web'),
    'leads', l.id::text
  FROM leads l
  WHERE COALESCE(NULLIF(l.full_name, ''), l.owner_name, '') <> 'DRAFT'
  ON CONFLICT DO NOTHING;
EXCEPTION WHEN undefined_table OR undefined_column THEN RAISE NOTICE 'skip leads backfill';
END; $do$;

-- Dealer onboarding applications (web wizard + WhatsApp bot).
DO $do$ BEGIN
  INSERT INTO lead_registry (created_at, lead_type, name, phone, source_channel, source_table, source_id)
  SELECT
    COALESCE(a.created_at, now()),
    'dealer',
    COALESCE(NULLIF(a.owner_name, ''), NULLIF(NULLIF(a.company_name, 'WhatsApp onboarding (pending)'), ''), 'Unknown'),
    LEFT(COALESCE(NULLIF(a.owner_phone, ''), NULLIF(a.wa_phone, '')), 20),
    CASE WHEN a.source = 'whatsapp' THEN 'whatsapp' ELSE 'web' END,
    'dealer_onboarding_applications', a.id::text
  FROM dealer_onboarding_applications a
  ON CONFLICT DO NOTHING;
EXCEPTION WHEN undefined_table OR undefined_column THEN RAISE NOTICE 'skip dealer_onboarding_applications backfill';
END; $do$;

-- Dealer acquisition pipeline (inside-sales / ASM manual entries + imports).
DO $do$ BEGIN
  INSERT INTO lead_registry (created_at, lead_type, name, phone, source_channel, source_table, source_id)
  SELECT
    COALESCE(d.created_at, now()),
    'dealer',
    COALESCE(NULLIF(d.dealer_name, ''), 'Unknown'),
    LEFT(NULLIF(d.phone, ''), 20),
    'web',
    'dealer_leads', d.id::text
  FROM dealer_leads d
  ON CONFLICT DO NOTHING;
EXCEPTION WHEN undefined_table OR undefined_column THEN RAISE NOTICE 'skip dealer_leads backfill';
END; $do$;

-- NBFC partners (admin-created onboarding records).
DO $do$ BEGIN
  INSERT INTO lead_registry (created_at, lead_type, name, phone, source_channel, source_table, source_id)
  SELECT
    COALESCE(n.created_at, now()),
    'nbfc',
    COALESCE(NULLIF(n.legal_name, ''), 'Unknown'),
    LEFT(NULLIF(n.primary_contact_phone, ''), 20),
    'web',
    'nbfc', n.id::text
  FROM nbfc n
  ON CONFLICT DO NOTHING;
EXCEPTION WHEN undefined_table OR undefined_column THEN RAISE NOTICE 'skip nbfc backfill';
END; $do$;

-- OEMs (phone = sales-head contact).
DO $do$ BEGIN
  INSERT INTO lead_registry (created_at, lead_type, name, phone, source_channel, source_table, source_id)
  SELECT
    COALESCE(o.created_at, now()),
    'oem',
    COALESCE(NULLIF(o.business_entity_name, ''), 'Unknown'),
    LEFT((SELECT ct.contact_phone FROM oem_contacts ct
          WHERE ct.oem_id = o.id AND ct.contact_role = 'sales_head' LIMIT 1), 20),
    'web',
    'oems', o.id::text
  FROM oems o
  ON CONFLICT DO NOTHING;
EXCEPTION WHEN undefined_table OR undefined_column THEN RAISE NOTICE 'skip oems backfill';
END; $do$;
