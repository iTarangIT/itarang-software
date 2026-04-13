-- Migration: Step 1 Readiness
ALTER TABLE "leads" ADD COLUMN "is_current_same" boolean DEFAULT false NOT NULL;
ALTER TABLE "leads" ADD COLUMN "product_type_id" varchar(255);

-- Safe migration for product_category_id (UUID -> VARCHAR)
ALTER TABLE "leads" ALTER COLUMN "product_category_id" TYPE varchar(255) USING "product_category_id"::varchar;

-- Enum Enforcement (Postgres CHECK constraints)
ALTER TABLE "leads" ADD CONSTRAINT "leads_interest_level_check" CHECK ("interest_level" IN ('hot', 'warm', 'cold'));
ALTER TABLE "leads" ADD CONSTRAINT "leads_status_check" CHECK ("status" IN ('INCOMPLETE', 'ACTIVE', 'CONVERTED', 'ABANDONED'));
ALTER TABLE "leads" ADD CONSTRAINT "leads_ocr_status_check" CHECK ("ocr_status" IN ('success', 'partial', 'failed'));
