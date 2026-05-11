-- E-092 — CDS/PCI Score Explainability Drawer (BRD §6.4.5)
-- Two append-only tables that persist each score computation along with the
-- exact EMI inputs used, so the explainability drawer renders the inputs that
-- produced the displayed score (no recomputation drift).

CREATE TABLE IF NOT EXISTS "nbfc_score_runs" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "loan_application_id" varchar(255) NOT NULL,
    "score_type" varchar(8) NOT NULL,
    "score_value" numeric(6, 2) NOT NULL,
    "computed_at" timestamp with time zone DEFAULT now() NOT NULL,
    "confidence_level" varchar(8) NOT NULL,
    "confidence_reasons" jsonb
);

CREATE INDEX IF NOT EXISTS "nbfc_score_runs_loan_idx"
    ON "nbfc_score_runs" ("loan_application_id");
CREATE INDEX IF NOT EXISTS "nbfc_score_runs_loan_type_idx"
    ON "nbfc_score_runs" ("loan_application_id", "score_type");
CREATE INDEX IF NOT EXISTS "nbfc_score_runs_computed_at_idx"
    ON "nbfc_score_runs" ("computed_at");

CREATE TABLE IF NOT EXISTS "nbfc_score_input_snapshots" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "score_run_id" uuid NOT NULL,
    "row_index" integer NOT NULL,
    "due_date" timestamp with time zone,
    "amount" numeric(12, 2),
    "status" varchar(24),
    "days_late" integer,
    "contribution" numeric(6, 2)
);

CREATE INDEX IF NOT EXISTS "nbfc_score_input_snapshots_run_idx"
    ON "nbfc_score_input_snapshots" ("score_run_id");
CREATE INDEX IF NOT EXISTS "nbfc_score_input_snapshots_run_row_idx"
    ON "nbfc_score_input_snapshots" ("score_run_id", "row_index");
