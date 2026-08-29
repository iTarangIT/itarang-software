------------------------------------------------------------------------------
-- E-218: spend buckets on expenses — the layer the CEO reads at a glance.
--
-- The Expenses card on /ceo opens a flat list of every approved invoice with a
-- single total. It answers "how much did we spend" and nothing else: there is
-- no way to see WHERE the money went without reading 200 rows, and no way to
-- compare one month against another.
--
-- E-106 already added `department` (ops/sales/marketing/tech/hr/finance/admin),
-- LLM-classified on every ingested invoice. That answers "whose budget is
-- this?". It does NOT answer "what kind of spend is this?" — a Trontek battery
-- order and an AWS bill both sit under Tech as a department while being
-- completely different kinds of money. Departments are also too many to read as
-- tiles, and their split is roughly the same every month.
--
-- `bucket` is the coarser layer above department: four groupings —
--   tech    Software, SaaS, cloud, IT hardware, developer/AI tooling
--   rm      Raw material and components — cells, chargers, harnesses, motors
--   misc    Running the business — travel, office, rent, freight, statutory
--   others  Anything not clearly one of the three above
--
-- WHY NO CHECK CONSTRAINT AND NO ENUM:
--   The taxonomy is fixed in TypeScript (src/lib/expenses.ts, EXPENSE_BUCKETS)
--   and validated by zod at every write path, so a bad value cannot reach the
--   column through the app. A DB-side CHECK would buy nothing there and would
--   cost a migration every time a bucket is added or renamed — and ALTER TYPE
--   on a shared, drifting DB is exactly what these conventions exist to avoid
--   (see E-216_drive_expense_ingestion.sql). Same reasoning as E-202's
--   dealer_type: free text, validated in the app.
--
-- WHY `bucket_source`:
--   A bucket is decided by a rule, by the model, by a human correction, or by
--   the fallback. The backfill script must never overwrite a human's answer,
--   and "the model guessed this" versus "a rule fixed this" is the difference
--   between a number worth trusting and one worth checking. One column makes
--   both answerable without re-deriving anything.
--     rule | ai | manual | default
--
-- NO BACKFILL HERE ON PURPOSE. Classifying the existing rows needs the rule
-- engine and, for the leftovers, model calls — that belongs in a script whose
-- output can be read before it writes:
--   node --import tsx --env-file=.env.local scripts/_backfill-expense-buckets.ts
--   node --import tsx --env-file=.env.local scripts/_backfill-expense-buckets.ts --apply
--
-- Additive, idempotent, safe to re-run. Apply via pgAdmin (never db:push).
------------------------------------------------------------------------------

ALTER TABLE expense_submissions
  ADD COLUMN IF NOT EXISTS bucket        varchar(24),
  ADD COLUMN IF NOT EXISTS bucket_source varchar(16);

COMMENT ON COLUMN expense_submissions.bucket IS
  'E-218: coarse spend bucket — tech | rm | misc | others. Sits above `department`: department is whose budget, bucket is what kind of spend. NULL means not yet classified (pre-E-218 rows until the backfill runs); the dashboard shows those as "Unclassified" so the tiles still sum to the total. Free text validated in the app against EXPENSE_BUCKETS in src/lib/expenses.ts — deliberately not a CHECK or an enum.';

COMMENT ON COLUMN expense_submissions.bucket_source IS
  'E-218: who decided the bucket — rule (a named vendor/keyword in bucketRules.ts, deterministic) | ai (the model, above the 0.5 confidence floor) | manual (a human corrected it in the admin tracker — the backfill must never overwrite these) | default (nothing matched, filed under "others").';

-- The dashboard groups by bucket over a date window, always for approved rows
-- only. Partial so it stays small: the pending/rejected rows are never summed.
-- Migration-only predicate — drizzle has no partial-index syntax, so schema.ts
-- declares the plain index and this file is the source of truth.
CREATE INDEX IF NOT EXISTS expense_submissions_bucket_date_idx
  ON expense_submissions (bucket, expense_date)
  WHERE status = 'approved';

-- Finding what the backfill still has to do, and what a human has pinned.
CREATE INDEX IF NOT EXISTS expense_submissions_bucket_source_idx
  ON expense_submissions (bucket_source)
  WHERE bucket_source IS NOT NULL;
