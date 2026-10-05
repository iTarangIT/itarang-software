-- E-325 — "Onboarded by" on accounts activated before E-322 (tracker ID 65,
-- decided 29 Sep 2026).
--
-- E-322 stamps accounts.onboarded_by_user_id at activation, so every account
-- approved before it has the field empty. "Onboarded by" is a fixed fact about
-- how the dealer came in — "from the onboarding dropdown, or the lead's closing
-- owner when it came through a lead" — so it can be read back from what is
-- already recorded:
--
--   1. the salesperson on the approved onboarding (E-321), when one was picked;
--   2. else the closing owner of the lead the account came through.
--
-- Only users that exist are written. Accounts with neither stay empty.
--
-- The account OWNER is still NOT backfilled: "no automatic assignment" is a
-- locked rule, and old accounts are tagged by Admin / CEO in Account management.
--
-- Before that, "Came through" is completed for accounts E-322 could only mark
-- 'direct': the spec links an account to a lead "where the phone matches an
-- existing lead", which the approve route now does for new approvals. Here the
-- same match is applied to accounts already activated — account contact phone
-- against the lead's phone, last 10 digits, a lead already won preferred, then
-- the newest. It only records where the account came from; no lead is moved to
-- Converted.
--
-- Data only, no DDL. Requires E-321 and E-322. Only fills what is empty, so a
-- re-run is a no-op.

DO $do$
BEGIN
    UPDATE accounts a
       SET originating_dealer_lead_id = m.lead_id,
           came_through = 'lead'
      FROM (
          SELECT a2.id,
                 (SELECT dl.id
                    FROM dealer_leads dl
                   WHERE right(regexp_replace(COALESCE(dl.phone, ''), '[^0-9]', '', 'g'), 10)
                         = right(regexp_replace(COALESCE(a2.contact_phone, ''), '[^0-9]', '', 'g'), 10)
                     AND dl.is_active IS NOT FALSE
                   ORDER BY (dl.lead_status IN ('Won', 'Converted')) DESC NULLS LAST, dl.created_at DESC NULLS LAST
                   LIMIT 1) AS lead_id
            FROM accounts a2
           WHERE a2.originating_dealer_lead_id IS NULL
             AND length(right(regexp_replace(COALESCE(a2.contact_phone, ''), '[^0-9]', '', 'g'), 10)) = 10
             AND EXISTS (SELECT 1 FROM dealers d WHERE d.dealer_id = a2.id)
      ) m
     WHERE m.id = a.id
       AND m.lead_id IS NOT NULL
       AND a.originating_dealer_lead_id IS NULL;
EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'E-325: lead link skipped (%).', SQLERRM;
END;
$do$;

DO $do$
BEGIN
    UPDATE accounts a
       SET onboarded_by_user_id = src.user_id
      FROM (
          SELECT DISTINCT ON (a2.id)
                 a2.id,
                 COALESCE(sp.id, lu.id) AS user_id
            FROM accounts a2
            LEFT JOIN dealer_onboarding_applications app
                   ON app.dealer_code = a2.id
                  AND app.onboarding_status = 'approved'
                  AND COALESCE(app.is_branch_dealer, false) = false
            LEFT JOIN users sp ON sp.id = app.salesperson_user_id
            LEFT JOIN dealer_leads dl ON dl.id = a2.originating_dealer_lead_id
            LEFT JOIN users lu ON lu.id::text = dl.closing_owner_id
           WHERE a2.onboarded_by_user_id IS NULL
             AND EXISTS (SELECT 1 FROM dealers d WHERE d.dealer_id = a2.id)
           ORDER BY a2.id, app.approved_at DESC NULLS LAST
      ) src
     WHERE src.id = a.id
       AND src.user_id IS NOT NULL
       AND a.onboarded_by_user_id IS NULL;
EXCEPTION WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'E-325: backfill skipped (%).', SQLERRM;
END;
$do$;
