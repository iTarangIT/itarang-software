------------------------------------------------------------------------------
-- E-229: component-supplier spend belongs to Operations, keyed on the VENDOR.
--
-- NO DDL except one COMMENT ON. This file only corrects DATA.
--
-- WHY THIS EXISTS WHEN E-224 ALREADY SAID THE SAME THING
--   E-224 fixed exactly this bug — Trontek / Ecostar component invoices filed
--   under department 'tech' when production, not the tech team, bought them.
--   It was applied to database-1 (sandbox) on 2026-08-01 and works there:
--   0 rows now sit at department='tech' with a component vendor.
--
--   It CANNOT fix production, and re-running it there would report success
--   while moving nothing. E-224's UPDATE is keyed on the bucket:
--
--       WHERE department = 'tech' AND bucket = 'rm'
--
--   `bucket` is E-218's column. On database-2 (production) the column exists
--   but the E-218 backfill was never run: 211 of 222 expense rows have
--   bucket IS NULL, including every single Trontek and Ecostar invoice. The
--   predicate matches zero rows. Measured on database-2 on 2026-08-06:
--
--       bucket IS NULL   211 rows  Rs 2,21,83,468.97
--       bucket = 'rm'     10 rows  Rs   28,01,868.00
--       bucket = 'misc'    1 row   Rs        1,180.00
--
--   So this file keys on the thing that is actually populated — the vendor —
--   and is therefore correct on a DB with or without the bucket backfill.
--
-- THE RULE
--   A named component supplier's spend is Operations spend, whatever the
--   classifier said and whatever the bucket column happens to hold:
--
--       vendor ILIKE '%trontek%' OR '%ecostar%'  =>  department = 'ops'
--
--   This is not a per-invoice judgement. It is a fact about the vendor: they
--   sell cells and battery components, which production procures. The same
--   two fragments are the first two entries of VENDOR_DEPARTMENT_RULES in
--   src/lib/expenses/departmentRules.ts, so the data this file writes and the
--   department the code assigns to the NEXT Trontek invoice now agree.
--
-- WHY ONLY THESE TWO VENDORS
--   VENDOR_DEPARTMENT_RULES names twelve fragments (trontek, ecostar,
--   ampfusion, ayansh, exide, amaron, livguard, okaya, lohum, trinity
--   electric, aradhya). On database-1 and database-2 as at 2026-08-06 only
--   trontek and ecostar have any row sitting in department='tech'; the other
--   ten match nothing. Listing only what is actually wrong keeps this file a
--   record of a specific correction rather than a second, drifting copy of a
--   list that already lives in TypeScript. If another supplier turns up
--   misfiled later, that is a new E- file with its own measured counts.
--
-- WHY NOT SCOPED TO source='ai'
--   Same reasoning as E-224: the rule is a property of the vendor, not of who
--   typed the row. A hand-entered Trontek invoice on the Tech budget is wrong
--   for the same reason an extracted one is.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
--   It does not set `bucket` on the 211 NULL-bucket production rows. That is
--   the E-218 backfill's job (scripts/_backfill-expense-buckets.ts) and it is
--   a separate, larger change touching every vendor, not just these two. Until
--   it runs, production's bucket strip reads "Unclassified" for those rows —
--   which is honest, and unrelated to whose budget the spend is on.
--
-- REVERSIBILITY
--   `ai_raw` still holds the model's original department on every source='ai'
--   row, so the pre-reclass value stays recoverable per row.
--
-- MEASURED AGAINST database-2 (production) ON 2026-08-06, BEFORE APPLYING
--   79 rows / Rs 1,95,58,875.63 sit at department='tech' with these vendors:
--     Trontek Electronics Limited   56 rows  Rs 1,88,62,725.63
--     Ecostar Innovation Pvt Ltd    23 rows  Rs     6,96,150.00
--   Approved spend by department moves  tech Rs 2,04,08,098.97 -> Rs 8,49,223.34
--                                       ops  Rs   40,81,770.45 -> Rs 2,36,40,646.08
--
--   Against database-1 (sandbox) it matches 0 rows — E-224 already moved them
--   there on 2026-08-01. Applying this file to sandbox is a deliberate no-op
--   that proves the two environments now agree.
--
-- Data-only, idempotent, safe to re-run — the second run matches zero rows.
-- Apply via pgAdmin (never db:push).
------------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The reclass.
--
-- No `bucket` in the predicate anywhere — that is the whole point of this file
-- existing alongside E-224. Reading `vendor` only, it is correct on a DB whose
-- bucket backfill has run and on one whose has not.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  moved integer;
BEGIN
  UPDATE expense_submissions
     SET department = 'ops',
         updated_at = now()
   WHERE department = 'tech'
     AND (vendor ILIKE '%trontek%' OR vendor ILIKE '%ecostar%');

  GET DIAGNOSTICS moved = ROW_COUNT;
  RAISE NOTICE 'E-229: reclassified % component-supplier expense(s) from department tech -> ops', moved;

EXCEPTION
  -- `department` is E-106's column. A DB without it is one this file has
  -- nothing to say to.
  WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'E-229: expense_submissions.department not present — skipping';
END;
$do$;

-- ---------------------------------------------------------------------------
-- The column now carries two independent rules, so it says both.
--
-- Restated in full rather than appended to, because production never received
-- E-224 and so has none of that text on the column at all.
-- ---------------------------------------------------------------------------
DO $do$
BEGIN
  COMMENT ON COLUMN expense_submissions.department IS
    'E-106: whose budget the spend belongs to — ops | sales | marketing | tech | hr | finance | admin. Distinct from `bucket` (what KIND of spend it is). Two rules constrain it, both enforced by resolveDepartment() in src/lib/expenses/departmentRules.ts on every write path. E-224: raw material is production spend, so bucket = ''rm'' implies department = ''ops'', never ''tech''. E-229: a named component supplier (Trontek, Ecostar, and the rest of VENDOR_DEPARTMENT_RULES) is department ''ops'' regardless of bucket — needed because `bucket` is NULL on any DB where the E-218 backfill has not run, which made the E-224 predicate a no-op on production. Neither rule holds in reverse: a Canva subscription bought by marketing is department marketing and bucket tech. Free text validated in the app against EXPENSE_DEPARTMENTS in src/lib/expenses.ts — deliberately not a CHECK or an enum, so an admin correction in the expense tracker still has the last word.';
EXCEPTION
  WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'E-229: expense_submissions.department not present — skipping comment';
END;
$do$;
