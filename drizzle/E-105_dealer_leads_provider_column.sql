-- E-105 — add the missing `provider` column to dealer_leads.
--
-- schema.ts declared `provider: text("provider").default("bolna")` (commit
-- 024011d, Bolna/QStash integration) but no migration was ever shipped, so
-- production never got the column. Drizzle ORM still lists every schema
-- column in its INSERT statement — for omitted ones it emits the `default`
-- keyword — so every `db.insert(dealerLeads).values(...)` against prod was
-- producing `INSERT INTO dealer_leads (..., provider) VALUES (..., default)`
-- which Postgres rejected with "column provider does not exist". The catch
-- at src/lib/scraper/storage/leadStore.ts:97 swallowed the error as a
-- "duplicate count", so the run progress UI reported "0 promoted, N
-- duplicates" while the actual SQL never landed a row.
--
-- Additive, idempotent. Re-running is a no-op.

ALTER TABLE dealer_leads
    ADD COLUMN IF NOT EXISTS provider text DEFAULT 'bolna';
