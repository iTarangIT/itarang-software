------------------------------------------------------------------------------
-- E-224: raw-material spend belongs to Operations, not Tech.
--
-- NO DDL. This file only corrects DATA that a wrong classification rule wrote.
--
-- WHAT WENT WRONG
--   E-218 drew the right line between the two axes — department is whose budget
--   the spend is, bucket is what kind of spend it is. What it got wrong was the
--   worked example it taught the classifier, repeated verbatim in BOTH prompts
--   (extractInvoice.ts and classifyBucket.ts):
--
--       "a battery order raised by the tech team is department tech but bucket rm"
--
--   The model applied it faithfully. Every Trontek / Ecostar / Ayansh component
--   invoice was filed with bucket='rm' (correct — it is raw material) AND
--   department='tech' (wrong — production bought it, not the tech team). The
--   CEO's by-department strip on /ceo consequently read ₹38.42L of "Tech"
--   against ₹75K of Operations for Jul–Aug 2026. Tech was not spending that
--   money.
--
-- THE INVARIANT
--       bucket = 'rm'  ⇒  department <> 'tech'
--
--   Enforced in three places, because any one of them alone leaves the bug
--   half-fixed:
--     1. the prompts        — so new invoices are extracted correctly
--     2. resolveDepartment()— src/lib/expenses/departmentRules.ts, a
--                             deterministic rule that beats the model on every
--                             write path (Drive scan + bulk AI import)
--     3. this file          — so the ~rows ALREADY in the table are corrected.
--                             Re-prompting fixes nothing retroactively.
--
-- WHY NOT SCOPED TO source='ai'
--   The invariant is a property of the data, not of who wrote it. A hand-entered
--   battery invoice sitting on the Tech budget is wrong for exactly the same
--   reason, and leaving those behind would mean the dashboard still disagreed
--   with the rule the code now enforces.
--
-- WHY NOT A CHECK CONSTRAINT
--   Same reasoning as E-218's note on buckets: the taxonomy lives in TypeScript
--   (src/lib/expenses.ts) and is enforced by zod at every write path, and a
--   CHECK on a shared, drifting DB costs a migration every time the rule is
--   refined. It would also hard-fail an admin's manual correction rather than
--   letting a human have the last word, which is the wrong trade for a
--   judgement call about whose budget something came out of.
--
-- REVERSIBILITY
--   `ai_raw` still holds what the model originally said on every AI row, so the
--   pre-reclass department is recoverable per row if this ever needs auditing.
--
-- MEASURED AGAINST database-1 ON 2026-08-01, BEFORE APPLYING
--   97 rows / ₹2,20,35,690.63 sit at department='tech' AND bucket='rm'
--     Trontek Electronics       68 rows  ₹2,10,27,040.63
--     Ecostar Innovation        24 rows     ₹8,39,213.00
--     Trinity Electric Vehicles  1 row      ₹1,06,200.00
--     Neuron Energy              1 row        ₹21,240.00   (a 3.0 connector — genuinely rm)
--     Samsung / Dawntech         3 rows       ₹41,997.00   (a phone and two TVs — step 1
--                                                           re-buckets these to tech, so
--                                                           step 2 moves 94, not 97)
--   Approved spend by department goes  tech ₹2,28,75,426 → ₹8,81,732
--                                      ops    ₹16,76,544 → ₹2,36,70,238
--
-- VERIFIED by applying this file TWICE inside one transaction against
-- database-1 and rolling back: run 1 reported "re-bucketed 3" then
-- "reclassified 94", run 2 reported 0 and 0.
--
-- Data-only, idempotent, safe to re-run — the second run matches zero rows.
-- Apply via pgAdmin (never db:push).
------------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Step 1 — a bucket correction that has to land FIRST.
--
-- Verifying the reclass against database-1 turned up a second, smaller bug:
-- bucketRules.ts carries a deliberately broad `electronics -> rm` catch-all (the
-- safety net for the next unnamed component supplier called "X Electronics"),
-- and it was also swallowing consumer-electronics RETAILERS. Three rows —
-- a ₹24,999 Samsung "Mobile Phone" and two Dawntech televisions — were bucketed
-- `rm`. They are IT hardware, which is exactly what the tech bucket is for.
--
-- Left alone, step 2 below would then have moved them off the Tech budget as
-- raw material, which is the opposite of what this migration is for. So they are
-- corrected first, and step 2 no longer matches them.
--
-- `bucket_source <> 'manual'` because a human's correction is the last word —
-- the same guard the E-218 backfill script relies on.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  rebucketed integer;
BEGIN
  UPDATE expense_submissions
     SET bucket = 'tech',
         bucket_source = 'rule',
         updated_at = now()
   WHERE bucket = 'rm'
     AND COALESCE(bucket_source, '') <> 'manual'
     AND (vendor ILIKE '%samsung%' OR vendor ILIKE '%dawntech%');

  GET DIAGNOSTICS rebucketed = ROW_COUNT;
  RAISE NOTICE 'E-224: re-bucketed % consumer-electronics row(s) rm -> tech', rebucketed;

EXCEPTION
  WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'E-224: expense_submissions.bucket not present — skipping re-bucket';
END;
$do$;

-- ---------------------------------------------------------------------------
-- Step 2 — the reclass itself.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  moved integer;
BEGIN
  UPDATE expense_submissions
     SET department = 'ops',
         updated_at = now()
   WHERE department = 'tech'
     AND bucket = 'rm';

  GET DIAGNOSTICS moved = ROW_COUNT;
  RAISE NOTICE 'E-224: reclassified % rm-bucket expense(s) from department tech -> ops', moved;

EXCEPTION
  -- The column set is from E-106 (department) and E-218 (bucket). A DB that has
  -- neither is one this migration has nothing to say to.
  WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'E-224: expense_submissions.department/bucket not present — skipping';
END;
$do$;

-- The rule is now part of what the column means, so the column says so.
DO $do$
BEGIN
  COMMENT ON COLUMN expense_submissions.department IS
    'E-106: whose budget the spend belongs to — ops | sales | marketing | tech | hr | finance | admin. Distinct from `bucket` (what KIND of spend it is). E-224: raw material is production spend, so bucket = ''rm'' implies department = ''ops'', never ''tech'' — enforced by resolveDepartment() in src/lib/expenses/departmentRules.ts on every write path. The reverse does NOT hold: a Canva subscription bought by marketing is department marketing and bucket tech. Free text validated in the app against EXPENSE_DEPARTMENTS in src/lib/expenses.ts — deliberately not a CHECK or an enum.';
EXCEPTION
  WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'E-224: expense_submissions.department not present — skipping comment';
END;
$do$;
