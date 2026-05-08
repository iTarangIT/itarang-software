-- BRD V2 §5.4 — bring inventory_transfers in line with src/lib/db/schema.ts.
--
-- The previous shape of this table on RDS was a stale design with integer
-- PKs / integer dealer FKs / `rejected_*` columns that doesn't match the
-- rest of the inventory schema (which uses accounts.id varchar and users.id
-- uuid). The code in src/app/api/admin/inventory/transfer/route.ts and
-- src/app/api/dealer/inventory/acknowledge-transfer/route.ts assumes the
-- new shape, so every insert/select fails.
--
-- The table is empty (no successful transfers ever occurred — that's the
-- bug we're fixing), so a DROP + CREATE is safe.
--
-- Apply:  node -e "require('dotenv').config({path:'.env.local'}); const s=require('postgres')(process.env.DATABASE_URL,{ssl:'require',prepare:false}); s.file('drizzle/0038_inventory_transfers_cancellation_columns.sql').then(()=>s.end())"

DROP TABLE IF EXISTS inventory_transfers;

CREATE TABLE inventory_transfers (
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

CREATE INDEX inventory_transfers_source_idx ON inventory_transfers(source_dealer_id);
CREATE INDEX inventory_transfers_target_idx ON inventory_transfers(target_dealer_id);
CREATE INDEX inventory_transfers_status_idx ON inventory_transfers(status);
