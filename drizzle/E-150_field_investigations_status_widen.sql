-- E-150 — Widen field_investigations.status from varchar(20) to varchar(32).
--
-- Bug: the re-inspection flow (POST /api/nbfc/fi/[leadId]/action, action
-- "reinspect") sets status = 're_inspection_requested' — 23 characters — but
-- the column was varchar(20). Postgres rejected the UPDATE with
-- "value too long for type character varying(20)", so Request re-inspection
-- always failed. Every other status (assigned/in_progress/submitted/passed/
-- failed) fits in 20, which is why only re-inspection broke.
--
-- Widening a varchar length is non-destructive. Idempotent + re-runnable.

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'field_investigations'
      AND column_name = 'status'
      AND character_maximum_length < 32
  ) THEN
    ALTER TABLE field_investigations ALTER COLUMN status TYPE varchar(32);
  END IF;
END
$do$;
