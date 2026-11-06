# CRM wording audit batch 1 — "CEO pages (screens)" tab: hand-off

Source: `tasks/CRM_Wording_Audit_Batch1_04Nov.xlsx`, tab "CEO pages (screens)" (41 rows, Kartik OK 2 Nov).
Code changes: branch `wording-ceo-06nov` (ID 215). This file lists what is NOT code.

## People / process rows (no code)

| Row | Page | Owner | Action |
|---|---|---|---|
| 18 | Targets | CEO / Sales Head | Post this month's targets and get them accepted (Sonu's unaccepted since 22 Sept, Shrawan's still a draft). Until then the Sales dashboard scorecard shows "no target". The Targets page now says "Waiting for Sonu since 22 Sept (N days)". |
| 25 | Accounts Receivable | Finance / Chirag | Upload the first Vyapar Sale Report on Accounts Receivable (live since 29 Oct), then weekly. Until then every balance equals its total. |
| 31 | Sales dashboard | Kartik / Anirudh | Decide for Nidhi's 6,732 open leads (6,696 not worked): redistribute, or park old untouched leads out of her queue. |
| 35 | Leads | Kartik | **Hold** — business type on every new lead / AI call. Proposed: optional field with "Not sure", no Bolna script change. Waiting for Kartik's decision. |
| 37 | Leads | Kartik | The three-button Leads header is on sandbox — Kartik confirms before it goes live. |
| 41 | Ready to assign | Anirudh | Assign the real hot AI-qualified leads waiting past the limit (Shri Bala Ji E-bike, Ajit Automobiles, JTM Motors, ASIJA Electricals). |

## Data rows — scripts (dry run by default)

Run on **production** with the production env file (sandbox has been done, except the test logins, which testers use there):

```bash
# Rows 5 / 8 / 40 — read the plan it prints first
node --import tsx --env-file=.env.production scripts/_cleanup-test-data.ts
node --import tsx --env-file=.env.production scripts/_cleanup-test-data.ts --apply
# "... Recyclers" accounts are only listed; after checking each is a test row:
node --import tsx --env-file=.env.production scripts/_cleanup-test-data.ts --apply --close-recyclers
```

- Row 5 — "ASM Test" / "ISR Test" users: `is_active = false` + Supabase auth ban. Reversible.
- Row 8 — test accounts (Playwright Test Co, TEST-SIGNED Dealer, names with the whole word Test / Demo) closed via `closeAccount()` (Closed tab). Reversible (Reopen). Nothing deleted.
- Row 40 — test leads Aditya Tile / Lucky / Rushikesh Test Lead 0011 marked Lost (reason Other, "Test lead"). Won / Converted ones are only listed.

```bash
# Rows 9 / 26 — read-only GSTIN report → reports/account-gstins-<date>.csv
node --import tsx --env-file=.env.production scripts/verify-account-gstins.ts
```

- Row 9 (Admin / Finance): fix each listed GSTIN on the account page. Row 26: once a GSTIN is right, its "Not linked" invoices link on their own.

## Rows already done before this branch (on main since 3–5 Nov)

4 (one AR figure, ID 217), 7, 10, 11, 22, 30 (ID 218), 33, 34, 36, 37 (pending Kartik's sandbox OK), 38, 39.

## Tell the team once (Names tab rules 4 and 10)

Status names on screen and in downloads now read "Quote given" and "Dealer agreed" (stored codes unchanged). Any Excel formula, pivot or macro looking for "Commercials Explained" / "Commercials Finalised" must be updated.
