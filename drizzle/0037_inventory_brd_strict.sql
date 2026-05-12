-- BRD strict inventory parity migration
-- Adds canonical inventory fields, product-master split tables,
-- audit/write-off/paraphernalia ledgers, and status normalization.

ALTER TABLE "inventory"
  ADD COLUMN IF NOT EXISTS "inventory_type" varchar(30),
  ADD COLUMN IF NOT EXISTS "sub_category" varchar(100),
  ADD COLUMN IF NOT EXISTS "material_code" varchar(100),
  ADD COLUMN IF NOT EXISTS "iot_enabled" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "voltage_v" numeric(6,2),
  ADD COLUMN IF NOT EXISTS "capacity_ah" numeric(8,2),
  ADD COLUMN IF NOT EXISTS "output_current_a" numeric(6,2),
  ADD COLUMN IF NOT EXISTS "compatible_models" jsonb,
  ADD COLUMN IF NOT EXISTS "star_rating" integer,
  ADD COLUMN IF NOT EXISTS "physical_condition" varchar(20),
  ADD COLUMN IF NOT EXISTS "oem_warranty_date" date,
  ADD COLUMN IF NOT EXISTS "oem_warranty_months" integer,
  ADD COLUMN IF NOT EXISTS "oem_warranty_expiry" date,
  ADD COLUMN IF NOT EXISTS "oem_warranty_clauses" text,
  ADD COLUMN IF NOT EXISTS "upload_event_id" varchar(64);

-- Backfill BRD fields from existing values where possible.
UPDATE "inventory"
SET "iot_enabled" = CASE
  WHEN "iot_imei_no" IS NOT NULL AND trim("iot_imei_no") <> '' THEN true
  ELSE false
END
WHERE "iot_enabled" = false;

UPDATE "inventory"
SET "inventory_type" = CASE
  WHEN lower(coalesce("asset_type", '')) LIKE '%battery%' THEN 'battery'
  WHEN lower(coalesce("asset_type", '')) LIKE '%charger%' THEN 'charger'
  ELSE 'paraphernalia_lot'
END
WHERE "inventory_type" IS NULL;

UPDATE "inventory"
SET "sub_category" = COALESCE("sub_category", "asset_type")
WHERE "sub_category" IS NULL;

UPDATE "inventory"
SET "oem_warranty_date" = COALESCE("oem_warranty_date", ("manufacturing_date" AT TIME ZONE 'UTC')::date)
WHERE "oem_warranty_date" IS NULL;

UPDATE "inventory"
SET "oem_warranty_months" = COALESCE("oem_warranty_months", "warranty_months", 0)
WHERE "oem_warranty_months" IS NULL;

UPDATE "inventory"
SET "oem_warranty_expiry" = COALESCE(
  "oem_warranty_expiry",
  ("oem_warranty_date" + make_interval(months => COALESCE("oem_warranty_months", 0)))::date
)
WHERE "oem_warranty_expiry" IS NULL;

-- Status normalization.
UPDATE "inventory" SET "status" = 'available' WHERE "status" = 'in_stock';
UPDATE "inventory" SET "status" = 'written_off' WHERE "status" = 'write_off';

ALTER TABLE "inventory" ALTER COLUMN "status" SET DEFAULT 'available';

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_serial_unique" ON "inventory" ("serial_number");
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_imei_unique" ON "inventory" ("iot_imei_no");
CREATE INDEX IF NOT EXISTS "inventory_dealer_status_idx" ON "inventory" ("dealer_id", "status");
CREATE INDEX IF NOT EXISTS "inventory_invoice_date_idx" ON "inventory" ("oem_invoice_date");

-- BRD-aligned upload event metadata on existing report table.
ALTER TABLE "inventory_upload_reports"
  ADD COLUMN IF NOT EXISTS "inventory_type" varchar(30),
  ADD COLUMN IF NOT EXISTS "upload_method" varchar(20),
  ADD COLUMN IF NOT EXISTS "rows_imported" integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "rows_skipped" integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "file_url" text,
  ADD COLUMN IF NOT EXISTS "report_url" text;

UPDATE "inventory_upload_reports"
SET
  "inventory_type" = COALESCE("inventory_type", "asset_type"),
  "upload_method" = COALESCE("upload_method", "source"),
  "rows_imported" = COALESCE("rows_imported", "inserted_rows", 0),
  "rows_skipped" = COALESCE("rows_skipped", "skipped_rows", 0);

CREATE TABLE IF NOT EXISTS "inventory_events" (
  "id" varchar(64) PRIMARY KEY NOT NULL,
  "serial_number" varchar(255) NOT NULL,
  "inventory_id" varchar(255),
  "event_type" varchar(40) NOT NULL,
  "from_status" varchar(30),
  "to_status" varchar(30),
  "lead_id" varchar(255),
  "performed_by" uuid,
  "performed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "notes" text,
  "metadata" jsonb
);
CREATE INDEX IF NOT EXISTS "inventory_events_serial_idx"
  ON "inventory_events" ("serial_number", "performed_at");
CREATE INDEX IF NOT EXISTS "inventory_events_type_idx"
  ON "inventory_events" ("event_type");

CREATE TABLE IF NOT EXISTS "inventory_write_offs" (
  "id" varchar(64) PRIMARY KEY NOT NULL,
  "inventory_id" varchar(255) NOT NULL,
  "serial_number" varchar(255) NOT NULL,
  "reason" varchar(50) NOT NULL,
  "reason_notes" text,
  "supporting_doc_url" text,
  "write_off_value" numeric(12,2) NOT NULL,
  "requires_second_approval" boolean DEFAULT false NOT NULL,
  "approval_status" varchar(30) DEFAULT 'completed' NOT NULL,
  "second_approved_by" uuid,
  "second_approved_at" timestamp with time zone,
  "written_off_by" uuid NOT NULL,
  "written_off_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "inventory_write_offs_inventory_idx"
  ON "inventory_write_offs" ("inventory_id");
CREATE INDEX IF NOT EXISTS "inventory_write_offs_serial_idx"
  ON "inventory_write_offs" ("serial_number");

CREATE TABLE IF NOT EXISTS "paraphernalia_stock" (
  "id" varchar(64) PRIMARY KEY NOT NULL,
  "dealer_id" varchar(255) NOT NULL,
  "item_type" varchar(50) NOT NULL,
  "item_label" varchar(100) NOT NULL,
  "compatible_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "available_qty" integer DEFAULT 0 NOT NULL,
  "reserved_qty" integer DEFAULT 0 NOT NULL,
  "sold_qty" integer DEFAULT 0 NOT NULL,
  "unit_cost" numeric(10,2) DEFAULT 0 NOT NULL,
  "last_upload_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "paraphernalia_stock_dealer_type_unique"
  ON "paraphernalia_stock" ("dealer_id", "item_type");
CREATE INDEX IF NOT EXISTS "paraphernalia_stock_dealer_idx"
  ON "paraphernalia_stock" ("dealer_id");

CREATE TABLE IF NOT EXISTS "product_master_batteries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "model_id" varchar(50) NOT NULL,
  "model_name" varchar(100) NOT NULL,
  "compatible_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "compatible_sub_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "voltage_v" numeric(6,2),
  "capacity_ah" numeric(8,2),
  "battery_chemistry" varchar(20),
  "warranty_months" integer DEFAULT 0 NOT NULL,
  "iot_compatible" boolean DEFAULT false NOT NULL,
  "compatible_charger_models" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" varchar(20) DEFAULT 'active' NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "pm_battery_model_id_unique" ON "product_master_batteries" ("model_id");
CREATE INDEX IF NOT EXISTS "pm_battery_status_idx" ON "product_master_batteries" ("status");

CREATE TABLE IF NOT EXISTS "product_master_chargers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "model_id" varchar(50) NOT NULL,
  "model_name" varchar(100) NOT NULL,
  "output_voltage_v" numeric(6,2),
  "output_current_a" numeric(6,2),
  "charging_type" varchar(30),
  "compatible_battery_models" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "base_price" numeric(12,2),
  "warranty_months" integer DEFAULT 0 NOT NULL,
  "status" varchar(20) DEFAULT 'active' NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "pm_charger_model_id_unique" ON "product_master_chargers" ("model_id");
CREATE INDEX IF NOT EXISTS "pm_charger_status_idx" ON "product_master_chargers" ("status");

CREATE TABLE IF NOT EXISTS "product_master_paraphernalia" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "item_type_code" varchar(50) NOT NULL,
  "display_label" varchar(100) NOT NULL,
  "compatible_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "max_qty_per_lead" integer DEFAULT 0 NOT NULL,
  "harness_variant" boolean DEFAULT false NOT NULL,
  "status" varchar(20) DEFAULT 'active' NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "pm_para_item_type_unique" ON "product_master_paraphernalia" ("item_type_code");
CREATE INDEX IF NOT EXISTS "pm_para_status_idx" ON "product_master_paraphernalia" ("status");
