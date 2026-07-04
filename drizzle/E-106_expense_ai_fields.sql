-- E-106 — AI invoice expense tracker fields
--
-- Adds department / project-tag / vendor / expense-date / source / ai_raw columns
-- to expense_submissions so the admin-only AI invoice tracker can record
-- GPT-4o-extracted expenses and the CEO dashboard can break them down by
-- department and project. Strictly additive + idempotent — safe to re-run.

ALTER TABLE expense_submissions ADD COLUMN IF NOT EXISTS department varchar(32);
ALTER TABLE expense_submissions ADD COLUMN IF NOT EXISTS project_tag varchar(80);
ALTER TABLE expense_submissions ADD COLUMN IF NOT EXISTS vendor varchar(160);
ALTER TABLE expense_submissions ADD COLUMN IF NOT EXISTS expense_date date;
ALTER TABLE expense_submissions ADD COLUMN IF NOT EXISTS source varchar(16) DEFAULT 'manual';
ALTER TABLE expense_submissions ADD COLUMN IF NOT EXISTS ai_raw jsonb;

CREATE INDEX IF NOT EXISTS expense_submissions_department_idx
  ON expense_submissions (department);

CREATE INDEX IF NOT EXISTS expense_submissions_department_project_idx
  ON expense_submissions (department, project_tag);
