# AI Analyst read-only login (`analyst_ro`) — run record

Tracker ID 167: the Analyst sends query results to Gemini, so the "iTarang
database" source reads through `analyst_ro`. It is set up by
`scripts/_create-analyst-readonly-role.mjs`. The script uses an allowlist of
tables. On those tables it withholds person names, phone numbers, emails,
addresses (city only), KYC, bank / loan / account numbers, vehicle numbers,
notes / remarks / summaries / transcripts and raw payloads. Ecofy customers
are read only through the masked view `analyst_ecofy_leads` ("Customer #<code>").
Customer loan files are read only through `analyst_loan_files` and
`analyst_loan_applications` (17 Oct): "Customer #<code>", city and state, amounts,
dates and statuses; no name, NBFC reference, disbursal reference, EMI schedule or
rejection text. The base loan tables are not granted.

The run also refuses outside databases in the CRM itself (17 Oct): an outside
Postgres source is hidden from the source list and a question sent to one gets 403.

Re-run the script after any migration that adds a column to an allowed table:
a new column stays unreadable until it is granted.

**18 Oct rework (ID 167 rows 14 / 51–66, IDs 148 / 192) — NOT yet run anywhere.** The
script now also withholds dealer / shop names, location and area, family, every reason
column, AI signals / score breakdown / intent details, memory and call-note history,
attachments, file links and stored-file keys / names, payment references and transaction
ids, e-sign ids and errors, call outcomes and attempt history, NeoDove agent / tag / stage,
suggested actions and CEO recommendations, deployment location, telemetry blobs and expense
vendors. The raw `leads` table is no longer granted: it is read through `analyst_leads`
("Customer #<code>" from an md5 of the lead id, city and state, no ids or free text), and the
loan views carry that code instead of `lead_id`. New grants: `accounts`, `account_closures`,
`account_ownership`, `time_limit_settings`, `holiday_calendar`, plus views
`analyst_account_flags` (gstin_missing, is_dealer) and `analyst_staff` (user id + role). The
run ends with a check (`all_rules_hold`) and exits 1 if a sampled withheld column is still
readable, a sampled kept column is not, raw `leads` is granted or a view carries a lead id.

To apply it:
1. Re-run on **db-1 (sandbox)**, password unchanged:
   `node --env-file=.env.local scripts/_create-analyst-readonly-role.mjs` (a `DRY_RUN=1` first shows
   what it would withhold). Check `all_rules_hold: true` and add a row below.
2. **db-2 (prod) only after the go-ahead**: the prod steps below (the role still has to be created
   there), then the same check and a row below.
3. After each run: in the Analyst, Data sources › iTarang database › **Refresh tables**, so the
   withheld columns and the raw `leads` table drop out of the table list. Record that too.

| Date | Database | Run | Result |
|---|---|---|---|
| 2026-10-16 | db-1 (sandbox) | `DRY_RUN=1` | Role exists. 40 tables readable in full before the run. |
| 2026-10-16 | db-1 (sandbox) | real run, password unchanged | SELECT on 68 tables (38 in full, 69 with some readable column). `users` blocked, withheld columns blocked, `ecofy_leads` base table blocked, `leads.owner_name` blocked. `analyst_ecofy_leads` granted, sample "Customer #0560baad". |
| 2026-10-16 | db-2 (prod) | `DRY_RUN=1` | **Role does NOT exist on prod.** 0 tables readable. The Analyst's "iTarang database" on prod therefore cannot be using a prod read-only login. See below. |
| 2026-10-17 | db-1 (sandbox) | real run, password unchanged | SELECT on 69 tables (40 in full, 72 with some readable column). New masked views `analyst_loan_files` (no rows yet) and `analyst_loan_applications` (sample "Customer #LEAD1773") granted; base loan tables not granted. `users`, `ecofy_leads`, `leads.owner_name` still blocked. |
| 2026-10-23 | db-1 (sandbox) | `DRY_RUN=1` (18 Oct script) | Role exists, 36 tables readable in full. Would create and grant all six masked views. |
| 2026-10-23 | db-1 (sandbox) | real run, password unchanged (18 Oct script, first run anywhere) | SELECT on 73 tables (36 in full, 79 with some readable column). **`all_rules_hold: true`**, exit 0: 32 sampled withheld columns blocked, 15 sampled kept columns readable, `users` / raw `leads` / `ecofy_leads` blocked, no view carries a lead id. Samples: `analyst_leads` "Customer #2D5F9332", `analyst_ecofy_leads` "Customer #5f93763b", `analyst_staff` "ceo". Probed through the real DSN as `analyst_ro`: `dealer_leads.dealer_name` / `.memory`, `leads.*`, `ai_call_logs.summary`, `device_battery_map.vehicle_number`, `users` all refused (42501); `analyst_leads` and `dealer_leads.city` readable. **Refresh tables in the Analyst: still to press.** |
| 2026-10-23 | Analyst agent | `_delete-analyst-outside-connections.ts` dry run | **Could not run.** The agent's sign-in project `okifeathrijchctwrdpu.supabase.co` (ANALYST_SUPABASE_URL) no longer exists in DNS (NXDOMAIN) and the Render agent did not answer within 90s. The saved outside sources stay hidden and refused, not deleted. This needs the agent's owner to restore or replace the Supabase project first. |

## Prod: to do (needs a password, so not run by Claude)

**Since 23 Oct the CRM fails closed:** a server whose `ANALYST_CRM_READONLY_DSN` login is not
`analyst_ro` (or that has no DSN at all) refuses to connect the iTarang database, refuses questions
on a saved iTarang source (403), and the tab says personal data is not masked yet. Uploads still
work. On prod that stays the case until steps 1 to 3 below are done.

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
6. Data sources › iTarang database › **Refresh tables**, then pick the tables again.
7. Clean-up of saved outside sources (once the agent's sign-in works again, see the 23 Oct row):
   `node --import tsx --env-file=.env.production scripts/_delete-analyst-outside-connections.ts`, then again with `--apply`.
   The agent is one shared tenant, so this clears sandbox too.
8. Add a row to the table above for each step.
