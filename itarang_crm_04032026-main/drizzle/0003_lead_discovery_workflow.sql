-- Lead Discovery Workflow: Google Maps scraping, phone dedup, intent bands
-- Migration: 0003_lead_discovery_workflow

-- Google Maps Discovery fields on leads
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "google_place_id" varchar(255);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "website" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "google_maps_uri" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "google_rating" numeric(3, 1);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "google_ratings_count" integer;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "google_business_status" varchar(50);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "google_business_types" jsonb;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "raw_source_payload" jsonb;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "scrape_query" text;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "scrape_batch_id" varchar(255);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "scraped_at" timestamp with time zone;
--> statement-breakpoint

-- Phone quality and dedup
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "phone_quality" varchar(20) DEFAULT 'valid';
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "normalized_phone" varchar(20);
--> statement-breakpoint

-- Intent band fields
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "intent_band" varchar(20);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "intent_scored_at" timestamp with time zone;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "intent_details" jsonb;
--> statement-breakpoint

-- Align aiCallLogs with LangGraph usage
ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "provider" varchar(50);
ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;
ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "ended_at" timestamp with time zone;
ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "model_used" varchar(50);
ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "intent_score" integer;
ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "intent_reason" text;
ALTER TABLE "ai_call_logs" ADD COLUMN IF NOT EXISTS "next_action" varchar(50);
--> statement-breakpoint

-- Create scrape_batches table
CREATE TABLE IF NOT EXISTS "scrape_batches" (
    "id" varchar(255) PRIMARY KEY NOT NULL,
    "query" text NOT NULL,
    "city" varchar(100),
    "state" varchar(100),
    "radius_meters" integer,
    "latitude" numeric(10, 8),
    "longitude" numeric(11, 8),
    "total_results" integer DEFAULT 0,
    "new_leads_created" integer DEFAULT 0,
    "duplicates_found" integer DEFAULT 0,
    "enriched_existing" integer DEFAULT 0,
    "no_phone_count" integer DEFAULT 0,
    "status" varchar(20) DEFAULT 'pending' NOT NULL,
    "error_message" text,
    "initiated_by" uuid NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "completed_at" timestamp with time zone
);
--> statement-breakpoint

-- Indexes
CREATE INDEX IF NOT EXISTS "leads_normalized_phone_idx" ON "leads" ("normalized_phone");
CREATE INDEX IF NOT EXISTS "leads_google_place_id_idx" ON "leads" ("google_place_id");
CREATE INDEX IF NOT EXISTS "leads_intent_band_idx" ON "leads" ("intent_band");
CREATE INDEX IF NOT EXISTS "leads_scrape_batch_id_idx" ON "leads" ("scrape_batch_id");
CREATE INDEX IF NOT EXISTS "leads_ai_managed_idx" ON "leads" ("ai_managed");
--> statement-breakpoint

-- Foreign key for scrape_batches
DO $$ BEGIN
    ALTER TABLE "scrape_batches" ADD CONSTRAINT "scrape_batches_initiated_by_fk" FOREIGN KEY ("initiated_by") REFERENCES "users"("id");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- Backfill normalized_phone for existing leads
UPDATE "leads" SET "normalized_phone" =
    CASE
        WHEN "phone" IS NOT NULL AND "phone" ~ '^\+91[0-9]{10}$' THEN "phone"
        WHEN "owner_contact" IS NOT NULL AND "owner_contact" ~ '^\+91[0-9]{10}$' THEN "owner_contact"
        ELSE NULL
    END
WHERE "normalized_phone" IS NULL;
--> statement-breakpoint

-- Backfill intent_band for existing leads with intent_score
UPDATE "leads" SET "intent_band" =
    CASE
        WHEN "intent_score" >= 70 THEN 'high'
        WHEN "intent_score" >= 40 THEN 'medium'
        WHEN "intent_score" IS NOT NULL THEN 'low'
        ELSE NULL
    END
WHERE "intent_score" IS NOT NULL AND "intent_band" IS NULL;
