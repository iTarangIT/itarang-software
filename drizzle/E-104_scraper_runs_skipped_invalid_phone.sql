-- E-104 — track invalid-phone skips alongside duplicates on scraper runs.
-- Without this column, the UI can show "15 scraped, 11 duplicates, 0 promoted"
-- with no explanation for the missing 4 — they were dropped by toTenDigits()
-- but the count never reached the progress card. Additive, idempotent.

ALTER TABLE scraper_runs
    ADD COLUMN IF NOT EXISTS new_leads_skipped_invalid_phone integer DEFAULT 0;
