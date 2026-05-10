-- E-026B — Bridge legacy `nbfc` (int PK, RBI master data) to `nbfc_tenants`
-- (uuid PK, portal multi-tenant scope) so sanction-loan can resolve a tenant
-- id from a chosen lender. The two tables are documented as intentionally
-- distinct (see schema.ts comment near `export const nbfc = pgTable(...)`),
-- but the loan workflow needs to write loan_sanctions.nbfc_id (a uuid into
-- nbfc_tenants), so we add a one-way FK column on the legacy side.
--
-- Strictly additive. Idempotent: re-running is a no-op.
-- The backfill UPDATE only fills NULL rows so it never overwrites a manual
-- mapping someone may have already set.

ALTER TABLE "nbfc"
  ADD COLUMN IF NOT EXISTS "tenant_id" uuid REFERENCES "nbfc_tenants"("id");

CREATE INDEX IF NOT EXISTS "nbfc_tenant_id_idx" ON "nbfc" ("tenant_id");

UPDATE "nbfc" n
SET    "tenant_id" = t."id"
FROM   "nbfc_tenants" t
WHERE  n."tenant_id" IS NULL
  AND  LOWER(TRIM(n."legal_name")) = LOWER(TRIM(t."display_name"));
