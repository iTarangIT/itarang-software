-- BRD V2 §5.4 — inter-dealer inventory transfers.
-- Apply manually:  psql $DATABASE_URL -f drizzle/migrations/0001_inventory_transfers.sql
-- Or in Supabase SQL editor: paste and run.

CREATE TABLE IF NOT EXISTS inventory_transfers (
  id                    varchar(64)  PRIMARY KEY,
  source_dealer_id      varchar(255) NOT NULL,
  target_dealer_id      varchar(255) NOT NULL,
  serials               jsonb        NOT NULL,
  reason                text,
  initiated_by          uuid         NOT NULL,
  initiated_at          timestamptz  NOT NULL DEFAULT now(),
  acknowledged_by       uuid,
  acknowledged_at       timestamptz,
  cancelled_by          uuid,
  cancelled_at          timestamptz,
  cancellation_reason   text,
  status                varchar(30)  NOT NULL DEFAULT 'pending_acknowledgement',
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inventory_transfers_source_idx
  ON inventory_transfers(source_dealer_id);
CREATE INDEX IF NOT EXISTS inventory_transfers_target_idx
  ON inventory_transfers(target_dealer_id);
CREATE INDEX IF NOT EXISTS inventory_transfers_status_idx
  ON inventory_transfers(status);
