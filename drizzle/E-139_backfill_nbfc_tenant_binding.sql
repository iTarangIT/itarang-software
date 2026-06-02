-- E-139 — Backfill the legacy `nbfc`.tenant_id binding and recover NBFC
-- Acquire-queue assignments that were silently dropped while the binding was
-- NULL.
--
-- Background: activateNbfc() seeds nbfc_tenants + nbfc_users but historically
-- never wrote nbfc.tenant_id back to the legacy `nbfc` row (fixed forward in
-- src/lib/nbfc/admin/activate-nbfc.ts alongside this migration). With a NULL
-- binding, the competitive-routing fan-out in
-- /api/lead/[id]/submit-product-selection cannot resolve a tenant for the
-- chosen lender, so it skips the insert into nbfc_lead_assignments — the lead
-- advances to pending_final_approval for the dealer but never surfaces in the
-- NBFC's /nbfc/acquire pipeline ("No leads yet").
--
-- E-026B already bridged some rows by legal_name = display_name, which is
-- unreliable (collapsed/missed rows). This migration binds by the *canonical*
-- key the activation flow uses: nbfc_tenants.slug = LOWER(TRIM(nbfc.nbfc_id)).
--
-- Strictly additive + idempotent. Re-running is a no-op:
--   1. Bind nbfc.tenant_id by slug (only where NULL — never clobber).
--   2. Recreate missing nbfc_lead_assignments from product_selections picks.
--   3. Reconcile any denormalised tenant_id drift on existing assignments.

-- 1) Bind nbfc.tenant_id by canonical slug. Only fills NULL rows so an existing
--    (possibly manually-set) binding is never overwritten.
UPDATE "nbfc" n
SET    "tenant_id" = t."id"
FROM   "nbfc_tenants" t
WHERE  n."tenant_id" IS NULL
  AND  t."slug" = LOWER(TRIM(n."nbfc_id"));

-- Diagnostics — flag rows needing manual attention without changing them:
--   * active nbfc rows still unbound (no slug-matching tenant), and
--   * rows whose existing binding disagrees with the slug match (E-026B drift).
DO $do$
DECLARE
  unbound_cnt integer;
  drift_cnt   integer;
BEGIN
  SELECT count(*) INTO unbound_cnt
  FROM "nbfc" n
  WHERE n."tenant_id" IS NULL AND n."status" = 'active';
  IF unbound_cnt > 0 THEN
    RAISE NOTICE 'E-139: % active nbfc row(s) still have NULL tenant_id (no nbfc_tenants.slug matching LOWER(nbfc_id)). Review manually.', unbound_cnt;
  END IF;

  SELECT count(*) INTO drift_cnt
  FROM "nbfc" n
  JOIN "nbfc_tenants" t ON t."slug" = LOWER(TRIM(n."nbfc_id"))
  WHERE n."tenant_id" IS NOT NULL AND n."tenant_id" <> t."id";
  IF drift_cnt > 0 THEN
    RAISE NOTICE 'E-139: % nbfc row(s) bound to a tenant that differs from the slug match (likely E-026B legal_name drift). NOT overwritten — review manually.', drift_cnt;
  END IF;
END; $do$;

-- 2) Recreate missing Acquire assignments from already-submitted finance picks.
--    product_selections.selected_nbfcs is a JSONB array of
--    { nbfc_id: "<int>", loan_product_id?: <int> }. Only NBFCs that now have a
--    tenant binding are recovered; the unique (lead_id, nbfc_id) index makes
--    this safe to re-run. id / created_at / updated_at use column defaults.
DO $do$ BEGIN
  INSERT INTO "nbfc_lead_assignments"
    ("lead_id", "nbfc_id", "tenant_id", "loan_product_id", "status", "assigned_at")
  SELECT ps."lead_id",
         (elem->>'nbfc_id')::int,
         n."tenant_id",
         NULLIF(elem->>'loan_product_id', '')::int,
         'pending',
         now()
  FROM   "product_selections" ps
  CROSS JOIN LATERAL jsonb_array_elements(ps."selected_nbfcs") AS elem
  JOIN   "nbfc" n ON n."id" = (elem->>'nbfc_id')::int
  WHERE  ps."payment_mode" = 'finance'
    AND  ps."selected_nbfcs" IS NOT NULL
    AND  jsonb_typeof(ps."selected_nbfcs") = 'array'
    AND  n."tenant_id" IS NOT NULL
  ON CONFLICT ("lead_id", "nbfc_id") DO NOTHING;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'E-139: skip assignment backfill — product_selections or nbfc_lead_assignments not present';
END; $do$;

-- 3) Reconcile denormalised drift (per the E-131 header note): if any existing
--    assignment's tenant_id no longer matches its nbfc's current binding, fix
--    it so the lead surfaces under the correct tenant's Acquire queue.
DO $do$ BEGIN
  UPDATE "nbfc_lead_assignments" la
  SET    "tenant_id" = n."tenant_id", "updated_at" = now()
  FROM   "nbfc" n
  WHERE  n."id" = la."nbfc_id"
    AND  n."tenant_id" IS NOT NULL
    AND  la."tenant_id" IS DISTINCT FROM n."tenant_id";
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'E-139: skip tenant reconcile — nbfc_lead_assignments not present';
END; $do$;
