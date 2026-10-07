-- E-324 — what a data download carried (tracker ID 13, decided 29 Sep 2026).
--
-- E-312 logs who downloaded which dataset, with which filters, and how many
-- rows. Reports › Data downloads adds two things the log must be able to show:
-- whether the file carried FULL phone numbers (Admin and CEO only, after
-- typing a reason) and the reason given, plus the file format.
--
--   data_download_log.full_phone  true = full numbers; false = masked
--   data_download_log.reason      the reason typed for full numbers
--   data_download_log.format      'xlsx' | 'csv'
--
-- Older rows keep full_phone = false / NULL reason, which is what they were:
-- the earlier exports recorded masking inside `filters.phone_masked`.
--
-- DDL: additive + idempotent. The table is not in schema.ts (E-312); the
-- writer falls back to the E-312 columns on a host without this migration.
-- Re-run = no-op.

DO $do$
BEGIN
    ALTER TABLE data_download_log
        ADD COLUMN IF NOT EXISTS full_phone boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS reason     text,
        ADD COLUMN IF NOT EXISTS format     varchar(8);

    CREATE INDEX IF NOT EXISTS data_download_log_created_idx
        ON data_download_log (created_at DESC);
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'E-324: data_download_log does not exist (apply E-312 first) — skip';
END;
$do$;
