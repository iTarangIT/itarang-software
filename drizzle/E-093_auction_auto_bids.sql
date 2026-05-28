-- E-093 — auction_auto_bids
-- BRD §6.1.7: Auto-Bid affordance on the PlaceBidModal. Stores the
-- per-tenant maximum the bidder is willing to spend on a lot. The active
-- partial-unique index guarantees at most one active auto-bid per
-- (lot_id, tenant_id) while preserving cancelled rows for audit.
--
-- Strictly additive. Idempotent. Re-running this file is a no-op.

CREATE TABLE IF NOT EXISTS auction_auto_bids (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id      uuid NOT NULL,
  tenant_id   uuid NOT NULL,
  max_amount  numeric(12, 2) NOT NULL,
  status      varchar(16) NOT NULL DEFAULT 'active',  -- active | cancelled | exhausted
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS auction_auto_bids_lot_tenant_active_uidx
  ON auction_auto_bids (lot_id, tenant_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS auction_auto_bids_lot_idx
  ON auction_auto_bids (lot_id);

CREATE INDEX IF NOT EXISTS auction_auto_bids_tenant_idx
  ON auction_auto_bids (tenant_id);
