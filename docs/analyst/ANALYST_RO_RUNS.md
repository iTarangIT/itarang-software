# AI Analyst read-only login (`analyst_ro`) — run record

Tracker ID 167: the Analyst sends query results to Gemini, so the "iTarang
database" source reads through `analyst_ro`. It is set up by
`scripts/_create-analyst-readonly-role.mjs`. The script uses an allowlist of
tables. On those tables it withholds person names, phone numbers, emails,
addresses (city only), KYC, bank / loan / account numbers, vehicle numbers,
notes / remarks / summaries / transcripts and raw payloads. Ecofy customers
are read only through the masked view `analyst_ecofy_leads` ("Customer #<code>").
Customer loan files are not on the allowlist.

Re-run the script after any migration that adds a column to an allowed table:
a new column stays unreadable until it is granted.

| Date | Database | Run | Result |
|---|---|---|---|
| 2026-10-16 | db-1 (sandbox) | `DRY_RUN=1` | Role exists. 40 tables readable in full before the run. |
| 2026-10-16 | db-1 (sandbox) | real run, password unchanged | SELECT on 68 tables (38 in full, 69 with some readable column). `users` blocked, withheld columns blocked, `ecofy_leads` base table blocked, `leads.owner_name` blocked. `analyst_ecofy_leads` granted, sample "Customer #0560baad". |
| 2026-10-16 | db-2 (prod) | `DRY_RUN=1` | **Role does NOT exist on prod.** 0 tables readable. The Analyst's "iTarang database" on prod therefore cannot be using a prod read-only login. See below. |

## Prod: to do (needs a password, so not run by Claude)

1. Choose a strong password (at least 16 characters) and keep it in the password manager.
2. Run against prod:
   ```bash
   ANALYST_RO_PASSWORD='<password>' node --env-file=.env.production scripts/_create-analyst-readonly-role.mjs
   ```
   The script prints the host before it changes anything; check it says `database-2`.
3. Set `ANALYST_CRM_READONLY_DSN=postgres://analyst_ro:<password>@<db-2 host>:5432/postgres?sslmode=require`
   in the prod env: on the box (`shared/.env`) **and** in the `PROD_ENV_FILE_B64` GitHub secret.
   Then `pm2 reload itarang-crm-web --update-env`.
4. In the Analyst (CEO login), remove the old iTarang database source and connect it again.
5. Business check: ask "show me a dealer's notes" and "a customer's vehicle number".
   The Analyst must say it cannot read them.
6. Add a row to the table above.
