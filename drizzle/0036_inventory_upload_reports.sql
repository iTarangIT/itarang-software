-- Admin inventory upload audit table (BRD Step 4 upstream feeder).
-- Apply via Supabase SQL editor or psql — do NOT use `npm run db:push`,
-- which would attempt to drop tables that exist in the live DB but aren't
-- declared in schema.ts.

CREATE TABLE IF NOT EXISTS "inventory_upload_reports" (
  "id"                      varchar(64)                PRIMARY KEY NOT NULL,
  "dealer_id"               varchar(255)               NOT NULL,
  "asset_type"              varchar(30)                NOT NULL,
  "uploaded_by"             uuid                       NOT NULL,
  "uploaded_at"             timestamp with time zone   NOT NULL DEFAULT now(),
  "total_rows"              integer                    NOT NULL DEFAULT 0,
  "inserted_rows"           integer                    NOT NULL DEFAULT 0,
  "skipped_rows"            integer                    NOT NULL DEFAULT 0,
  "errors_json"             jsonb,
  "inserted_inventory_ids"  jsonb,
  "source"                  varchar(20)                NOT NULL DEFAULT 'bulk',
  "notes"                   text
);

CREATE INDEX IF NOT EXISTS "inventory_upload_reports_dealer_idx"
  ON "inventory_upload_reports" ("dealer_id");

CREATE INDEX IF NOT EXISTS "inventory_upload_reports_uploaded_by_idx"
  ON "inventory_upload_reports" ("uploaded_by");

CREATE INDEX IF NOT EXISTS "inventory_upload_reports_uploaded_at_idx"
  ON "inventory_upload_reports" ("uploaded_at");
