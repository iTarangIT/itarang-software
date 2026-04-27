# NBFC Real-Data Onboarding Flow

How an actual NBFC partner goes from contract-signed → live dashboard with their book.

## The end state

Each NBFC partner sees a Risk page populated with cards computed against
**their** loans + **their borrowers' vehicles**. To get there, three things
must be true:

1. The CRM has a `nbfc_tenants` row for them and a `nbfc_users` row for each
   of their dashboard logins (one or more humans).
2. Every loan they want to risk-score lives in `loan_applications` and is
   bridged to a `vehicleno` in `nbfc_loans`.
3. `nbfc_loans.current_dpd` is being refreshed on a schedule (nightly cron is
   the default; tighter if their book demands it).

## Day-1 onboarding

### 1. Create the tenant

Itarang Ops runs a one-time SQL or admin script:

```sql
INSERT INTO nbfc_tenants (slug, display_name, contact_email, aum_inr)
VALUES ('lendingco', 'LendingCo NBFC Pvt Ltd', 'ops@lendingco.in', 250000000);
```

### 2. Invite the partner's dashboard users

```bash
npx tsx scripts/invite-nbfc-user.ts \
  --email risk@lendingco.in \
  --name "Risk Head" \
  --tenant lendingco \
  --role admin
```

Each call prints a one-time temp password. Hand it over via your normal
secure channel.

### 3. Bulk-import their loan ↔ vehicleno mapping

The partner exports a CSV from their LMS:

```
loan_application_id,vehicleno,emi_amount,emi_due_date_dom,outstanding_amount
LOAN-2026-0001,TK-51105-17IY-139082,4500,5,72000
LOAN-2026-0002,TK-51105-17IY-139095,5200,5,85000
...
```

Two ways to import:

**Option A — admin-driven (today):** Itarang Ops POSTs the CSV-as-JSON to
`/api/nbfc/loans/import` with their admin session.

```bash
curl -X POST https://crm.itarang.com/api/nbfc/loans/import \
  -H "Cookie: $YOUR_ADMIN_SESSION_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{
    "tenant_slug": "lendingco",
    "rows": [
      {"loan_application_id":"LOAN-2026-0001","vehicleno":"TK-...","emi_amount":4500,"emi_due_date_dom":5,"outstanding_amount":72000}
    ]
  }'
```

The endpoint:
- Validates every loan_application_id exists in `loan_applications` (rejects
  the whole batch if any are missing — fail-fast).
- Upserts `nbfc_loans` per row.
- Returns `{ok, inserted, updated, total_active_loans}`.

**Option B — partner self-service (Phase E future):** UI in `/nbfc/settings`
lets the partner upload a CSV themselves. Same endpoint under the hood;
just a UX layer.

### 4. Confirm the mapping

```sql
SELECT COUNT(*) FROM nbfc_loans WHERE tenant_id = (SELECT id FROM nbfc_tenants WHERE slug='lendingco');
```

Or visit `/nbfc/overview` as the partner — the "Active Loans" tile should
match what they imported.

## Daily operations

### Nightly DPD refresh

`/api/nbfc/loans/refresh-dpd` recomputes `current_dpd` from `loan_payments`.
Scheduled via Vercel cron in `vercel.json`:

```json
{
  "crons": [
    { "path": "/api/nbfc/loans/refresh-dpd", "schedule": "0 2 * * *" }
  ]
}
```

The current SQL is a heuristic — it computes DPD as `(NOW() - latest unpaid
payment_due_date)`. Replace with your real collections logic before going to
production. The schema and shape stay the same.

### Nightly card refresh

Eventually, also schedule the LangGraph workflow:

```json
{ "path": "/api/nbfc/risk/run-all-tenants", "schedule": "30 2 * * *" }
```

(That endpoint doesn't exist yet — Phase E. For now partners click "Re-run
analysis" themselves.)

## Adding / removing loans during the partner's lifecycle

### New loans
Re-POST `/api/nbfc/loans/import` with the new rows. Existing rows aren't
touched (ON CONFLICT DO UPDATE is idempotent on the same data).

### Closed / written-off loans
Mark inactive — leaves history intact:

```sql
UPDATE nbfc_loans
SET is_active = false, updated_at = NOW()
WHERE loan_application_id = $1;
```

The Risk page filters on `is_active = true`, so closed loans don't influence
hypothesis evaluations.

### Re-assigning a vehicle (rare — borrower swap)

```sql
UPDATE nbfc_loans SET vehicleno = $newvno WHERE loan_application_id = $1;
```

Next "Re-run analysis" picks up the new vehicleno automatically.

## Cleanup / off-boarding a tenant

```sql
-- Soft-disable
UPDATE nbfc_tenants SET is_active = false WHERE slug = 'lendingco';

-- Or full purge (cascades through nbfc_loans + risk_card_runs + nbfc_users)
DELETE FROM nbfc_tenants WHERE slug = 'lendingco';
-- Their auth users in Supabase remain — disable them separately if needed.
```

## Open questions for production

- **Where does loan_application_id come from when the loan was originated
  outside Itarang's CRM?** Today the import endpoint requires the loan to
  pre-exist in `loan_applications`. Two options for partners with their own
  LMS: (a) we create stub `loan_applications` rows during import, or (b) we
  add a `nbfc_loans.external_loan_id` column and stop FK'ing to
  `loan_applications` for tenant-imported books.
- **DPD source of truth.** The heuristic in `refresh-dpd` is a placeholder.
  Real partners send DPD nightly via SFTP / API push, not by Itarang
  computing it.
- **Vehicle mapping at scale.** A partner with 10k loans needs upload
  progress UI + chunked import (current limit is 5,000 rows per request).
