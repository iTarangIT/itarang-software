-- E-029 — EMI schedules ledger feeding the nightly CDS / PCI computations.
-- BRD §6.1.5. One row per scheduled EMI; status in
-- {paid, paid_late, missed, overdue, scheduled}; days_overdue is 0 for
-- on-time payments and the lateness count for late/overdue rows.
--
-- Naming note: an audit fuzzy-match flagged loan_files.overdue_days as a
-- token-level twin (different table, different concept). We keep the
-- BRD-canonical `days_overdue` here.
CREATE TABLE IF NOT EXISTS "emi_schedules" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "loan_sanction_id" varchar(255) NOT NULL,
    "due_date" date NOT NULL,
    "paid_at" timestamptz,
    "status" varchar(16) NOT NULL,
    "days_overdue" integer,
    "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "emi_schedules_loan_idx"
    ON "emi_schedules" ("loan_sanction_id");

CREATE INDEX IF NOT EXISTS "emi_schedules_loan_due_idx"
    ON "emi_schedules" ("loan_sanction_id", "due_date");
