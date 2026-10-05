-- E-322 — the dealer account model (tracker ID 65, handover P1-1 / P1-2,
-- decided 29 Sep 2026).
--
-- After activation a dealer is an ACCOUNT, not a lead. Until now the account
-- knew nothing about who brought it in or who looks after it: the onboarding
-- held a typed sales-manager name, and dealer health / revenue credit followed
-- the lead's current owner.
--
--   accounts (new columns)
--     onboarded_by_user_id       fixed — the onboarding's salesperson, or the
--                                lead's closing owner when it came through a lead
--     account_owner_id           changes with reassignment
--     account_owner_since        the effective date of the current owner
--     came_through               'lead' | 'direct'
--     originating_dealer_lead_id the lead, when it came through one
--     activated_at               when the account went live (admin approval)
--     gstin_corrected_at / _by   "Correct GSTIN" is an action on the account,
--                                never an edit of the onboarding
--
--   account_ownership_history    one row per owner change: from, to, reason,
--                                effective date, who made it. Reports read the
--                                owner ON A DATE from here (ID 68), so past
--                                revenue never moves with a reassignment.
--
-- BACKFILL (idempotent, facts only): activated_at, came_through and the lead id
-- are read from the approved onboarding. The OWNER is deliberately NOT
-- backfilled — "No automatic assignment" is a locked rule; Admin / CEO tag old
-- accounts in Account management, where a suggestion is shown as a hint.
--
-- DDL: additive + idempotent. Mirrored in schema.ts. Re-run = no-op.

DO $do$
BEGIN
    ALTER TABLE accounts
        ADD COLUMN IF NOT EXISTS onboarded_by_user_id       uuid,
        ADD COLUMN IF NOT EXISTS account_owner_id           uuid,
        ADD COLUMN IF NOT EXISTS account_owner_since        date,
        ADD COLUMN IF NOT EXISTS came_through               varchar(16),
        ADD COLUMN IF NOT EXISTS originating_dealer_lead_id text,
        ADD COLUMN IF NOT EXISTS activated_at               timestamptz,
        ADD COLUMN IF NOT EXISTS gstin_corrected_at         timestamptz,
        ADD COLUMN IF NOT EXISTS gstin_corrected_by         uuid;

    CREATE INDEX IF NOT EXISTS accounts_account_owner_idx
        ON accounts (account_owner_id);
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'E-322: accounts does not exist — skip';
END;
$do$;

CREATE TABLE IF NOT EXISTS account_ownership_history (
    id             uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id     varchar(255) NOT NULL,
    from_owner_id  uuid,
    to_owner_id    uuid,
    reason         text         NOT NULL,
    effective_date date         NOT NULL,
    changed_by     uuid,
    created_at     timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_ownership_history_account_idx
    ON account_ownership_history (account_id, effective_date DESC, created_at DESC);

-- Facts from the approved onboarding. Only fills what is still empty.
DO $do$
BEGIN
    UPDATE accounts a
       SET activated_at = COALESCE(a.activated_at, app.approved_at, a.created_at),
           originating_dealer_lead_id = COALESCE(
               a.originating_dealer_lead_id,
               app.originating_dealer_lead_id,
               (SELECT dl.id FROM dealer_leads dl
                 WHERE dl.dealer_onboarding_application_id::text = app.id::text
                 ORDER BY dl.created_at LIMIT 1)),
           came_through = COALESCE(
               a.came_through,
               CASE WHEN app.originating_dealer_lead_id IS NOT NULL
                      OR EXISTS (SELECT 1 FROM dealer_leads dl
                                  WHERE dl.dealer_onboarding_application_id::text = app.id::text)
                    THEN 'lead' ELSE 'direct' END)
      FROM dealer_onboarding_applications app
     WHERE app.dealer_code = a.id
       AND app.onboarding_status = 'approved'
       AND COALESCE(app.is_branch_dealer, false) = false
       AND (a.activated_at IS NULL OR a.came_through IS NULL);
EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'E-322: backfill skipped (%).', SQLERRM;
END;
$do$;
