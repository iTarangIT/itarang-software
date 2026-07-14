-- E-189 — rebuild inventory_transfers on canonical id types.
--
-- Symptom this fixes:
--   PostgresError 22P02: invalid input syntax for type integer:
--   "ACC-ITARANG-20260512-5f2f0d"
--   ...from GET /api/dealer/inventory/acknowledge-transfer, which filters
--   target_dealer_id = users.dealer_id (an accounts.id, varchar).
--
-- Cause: this DB still carries the pre-0038 design of inventory_transfers —
-- integer PK, integer dealer FKs, integer actor FKs, and rejected_* columns.
-- The rest of the inventory schema keys off accounts.id (varchar(255)) and
-- users.id (uuid), and src/lib/db/schema.ts has always declared the varchar
-- shape. drizzle/0038_inventory_transfers_cancellation_columns.sql was written
-- to correct this but was never applied here; E-141 later bolted cancelled_*/
-- created_at/updated_at onto the stale table, which made it *look* current
-- while the id types stayed wrong.
--
-- This supersedes 0038. Unlike 0038 (a bare DROP + CREATE) it is idempotent and
-- refuses to destroy data: it only drops the table when the stale schema is
-- present AND empty. A non-empty stale table aborts the migration — those rows
-- reference integer dealer ids that no longer resolve and need a human.
--
-- Apply:  paste into the Supabase/RDS SQL editor, or
--   node -e "require('dotenv').config({path:'.env.local'}); const s=require('postgres')(process.env.DATABASE_URL,{ssl:'require',prepare:false}); s.file('drizzle/E-189_inventory_transfers_canonical_ids.sql').then(()=>s.end())"

DO $do$
DECLARE
  v_type text;
  v_rows bigint;
BEGIN
  SELECT data_type INTO v_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name   = 'inventory_transfers'
    AND column_name  = 'target_dealer_id';

  IF v_type = 'character varying' THEN
    RAISE NOTICE 'E-189: inventory_transfers already canonical — skip';
    RETURN;
  ELSIF v_type IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM inventory_transfers' INTO v_rows;
    IF v_rows > 0 THEN
      RAISE EXCEPTION
        'E-189: inventory_transfers holds % row(s) under the stale integer schema. Refusing to drop — migrate these rows by hand and re-run.', v_rows;
    END IF;
    RAISE NOTICE 'E-189: dropping empty stale integer-id inventory_transfers';
    DROP TABLE inventory_transfers;
  END IF;

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
END;
$do$;
