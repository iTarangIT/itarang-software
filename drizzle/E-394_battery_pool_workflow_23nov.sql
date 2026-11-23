-- E-394 (was E-393 until 23 Nov merge; main took E-393 for LinkedIn) — Battery Pool / NBFC workflow changes (23 Nov 2026).
--
-- 1. nbfc_cibil_reviews.condition_docs — "Approve with conditions" now carries
--    a multi-select of the documents the approval depends on (RC copy,
--    co-borrower papers …; keys of src/lib/nbfc/condition-docs.ts). They are
--    raised as an additional-documents request automatically.
-- 2. lead_scheme_picks — the iTarang admin / sales head picks the NBFC scheme
--    (lender + loan product) before the file is submitted (WhatsApp or web).
--    One row per lead; beats the NBFC routing rules while the BRE allows it.
--    A separate table (not leads columns) so lead INSERTs are unaffected on a
--    DB that has not run this file yet.
-- 3. lead_resumes — resume a file an NBFC rejected once the customer sent
--    corrected documents: same dealer (old lead re-opened, new_lead_id = old)
--    or another dealer (a NEW lead is created; the rejected one is kept and
--    linked here as history).
--
-- Strictly additive + idempotent. Re-running is a no-op.

ALTER TABLE nbfc_cibil_reviews
  ADD COLUMN IF NOT EXISTS condition_docs jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS lead_scheme_picks (
  lead_id varchar(255) PRIMARY KEY,
  nbfc_id integer NOT NULL,
  loan_product_id integer NOT NULL,
  picked_by uuid,
  picked_by_name text,
  channel varchar(12) NOT NULL DEFAULT 'web',
  picked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_resumes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  old_lead_id varchar(255) NOT NULL,
  new_lead_id varchar(255) NOT NULL,
  from_dealer_id varchar(255),
  to_dealer_id varchar(255),
  mode varchar(16) NOT NULL,
  rejected_nbfc_id integer,
  rejection_reason text,
  note text,
  resumed_by uuid,
  resumed_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_resumes_old_lead_idx ON lead_resumes (old_lead_id);
CREATE INDEX IF NOT EXISTS lead_resumes_new_lead_idx ON lead_resumes (new_lead_id);
