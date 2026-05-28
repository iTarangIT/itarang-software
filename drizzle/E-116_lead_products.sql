-- E-116 — Persist extra products attached to a lead + primary product asset kind
--
-- The dealer new-lead "Product Details" card now has a 3-level cascade
-- (Asset Type -> Product Category -> Product). "Add Another Product" rows were
-- previously sent to the server but never stored; this migration adds the
-- `lead_products` table so they persist, and a `leads.asset_type` column so the
-- primary product's asset kind reloads when a lead is edited.
--
-- Idempotent + additive — safe to re-run.

ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "asset_type" varchar(20);

CREATE TABLE IF NOT EXISTS "lead_products" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "lead_id"             varchar(255) NOT NULL,
  "product_id"          uuid NOT NULL,
  "product_category_id" varchar(255),
  "category_slug"       varchar(16),
  "asset_type"          varchar(20),
  "created_at"          timestamp with time zone DEFAULT now() NOT NULL
);

-- One lookup per lead drives edit-mode rehydration of the extra-product rows.
CREATE INDEX IF NOT EXISTS "lead_products_lead_idx"
  ON "lead_products" ("lead_id");
