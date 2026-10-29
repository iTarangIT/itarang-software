-- =============================================================================
-- E-364 — TRAVEL EXPENSE PROOF: THE DAYS A CLAIM COVERS (tracker ID 197, PJP phase 1)
-- =============================================================================
-- WHY.
--   A Travel or Vehicle/Fuel claim said nothing about which day(s) it was for
--   (a manual claim saved no date), so the CEO could not check it against the
--   person's visits, and the same day could be claimed twice.
--
-- WHAT. expense_claim_days — one row per day a Travel / Vehicle/Fuel claim
--   covers: the claim, the person, the category, the day, the verdict shown
--   when it was submitted (supported = a verified visit that day, ID 196) and
--   the note the person gave (required for a not-supported day). The CRM never
--   prices or fills a claim; the CEO decides. The day evidence is read live
--   from lead_visits (E-363).
--
--   "Same day twice" (same person, same category, a pending or approved claim)
--   is checked in code against expense_submissions.status, so a rejected
--   claim's day can be claimed again.
--
-- NOT mirrored in schema.ts — raw SQL behind a to_regclass probe
-- (src/lib/expenses/travelProofStore.ts), so the code is safe before this file
-- is applied: without it Travel claims submit as before, with no days.
-- Strictly additive, idempotent: re-running is a no-op.
-- =============================================================================

CREATE TABLE IF NOT EXISTS expense_claim_days (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    expense_id  uuid NOT NULL,
    user_id     text NOT NULL,
    category    varchar(64) NOT NULL,
    day         date NOT NULL,
    verdict     varchar(16) NOT NULL,
    note        text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS expense_claim_days_user_day_idx ON expense_claim_days (user_id, category, day);
CREATE INDEX IF NOT EXISTS expense_claim_days_expense_idx ON expense_claim_days (expense_id);
CREATE UNIQUE INDEX IF NOT EXISTS expense_claim_days_expense_day_key ON expense_claim_days (expense_id, day);

DO $do$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expense_claim_days_verdict_chk') THEN
        ALTER TABLE expense_claim_days
            ADD CONSTRAINT expense_claim_days_verdict_chk CHECK (verdict IN ('supported', 'not_supported'));
    END IF;
END;
$do$;

COMMENT ON TABLE expense_claim_days IS
  'E-364 / ID 197 — the day(s) a Travel or Vehicle/Fuel claim covers, with the verdict at submit (verified visit that day or not) and the note.';
