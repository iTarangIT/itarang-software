-- E-118 — nbfc_buyback_requests (BRD §6.1.7 Recovery & Auction)
-- Customer-initiated battery buyback requests surfaced on the NBFC
-- Recovery & Auction page. Strictly additive. Idempotent — re-running this
-- file is a no-op.

CREATE TABLE IF NOT EXISTS "nbfc_buyback_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "customer_name" varchar(160) NOT NULL,
  "battery_serial" varchar(64) NOT NULL,
  "soh_percent" numeric(5, 2),
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- 'pending' | 'in_review' | 'completed'
  "evaluation_status" varchar(24) DEFAULT 'pending' NOT NULL,
  "offer_amount" numeric(12, 2),
  -- 'pending_evaluation' | 'offer_made' | 'accepted' | 'rejected'
  "status" varchar(24) DEFAULT 'pending_evaluation' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "nbfc_buyback_requests_tenant_idx"
  ON "nbfc_buyback_requests" ("tenant_id");

CREATE INDEX IF NOT EXISTS "nbfc_buyback_requests_status_idx"
  ON "nbfc_buyback_requests" ("status");
