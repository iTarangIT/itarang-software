# 13 Nov developer pack — Aditya: what is built, and the live steps / proof to post

Source: `tasks/iTarang_Dev_Pack_13Nov` (tracker tab **Aditya**, Developer briefs 10 Nov, AI Analyst
change list 10 Nov). Code went to `main` (sandbox) in one commit per feature, 14 Nov. **Production
is not deployed**: Kartik re-checks on the sandbox first (pack rule 3).

Every live command reads `.env.production` (db-2). Rule 2 of the pack applies to each write:
**dry run → post the counts → go-ahead from the person named → backup → run → post the result.**
Sandbox outputs from 14 Nov are in `BUILD_RESULTS.md`.

Prefix for every script: `node --import tsx --env-file=.env.production` (read-only unless it says `--apply`).

---

## Live steps (code already live or built; each needs its go-ahead)

| Step | IDs | Command (live) | Post | Go-ahead |
|---|---|---|---|---|
| L2 | 85, 86, 245 | `scripts/cleanup-limit-events-l2.ts` (dry run) → backup + `--apply --confirm-live` → `scripts/verify-id85-86-time-limits.ts` | per-person "Limits passed" before → after; the run's removed count = the dry run's | Kartik |
| L2 note | 245 | The dry run now also clears OLDER misses whose clock today's rules no longer find late (a visit's time = photo time, else logged time the same day, else 10:00). `--no-recheck` skips that. Run L2 **after** this release is on live so one re-record covers both causes. | | |
| L9 | 70 | `scripts/verify-id70-zoho-copy.ts` | invoices with lines; customers with a GSTIN; "accounts whose only orders are Zoho-era" | given |
| L19 | A16 | item-name back-fill (`scripts/backfill-…` from the 4 Nov build, dry run first) | count, then Gross margin "Unmapped" check | Kartik |
| L17 | 211, A34, 253 | 15-minute live test with Sonu (ASM) and Nidhi (ISR): RUNBOOK §13 test list | yes/no + screenshot per check | Kartik |
| L16 | 71 | waits for Finance to mark the credit-note folder | | Finance |

## Open items, by ID

### 225 — passwords (built: d91c6feb)
- Live, read-only: `scripts/list-seeded-test-logins.ts` → post the list; every row must say `can sign in: no`. A `YES`: deactivate it in Admin › Users (ID 219). Never try the password.
- Guard test now catches `const PASSWORD = '…'` etc. in scripts/, tests/, e2e/ and top-level files (`npx vitest run src/lib/security`).
- Still Apoorv: change the db-2 password, allow only the two servers, clean history (with 195).

### 248 — duplicate leads (built: f063607f; E-384 held)
1. Approved merges (Kartik 12 Nov), one at a time:
   `scripts/dup-leads-last10.ts --plan DL-1788853088140-D8iGR0r6 DL-muf9zhg0-a12b447e` (it refuses if the first id is the newer lead: swap them) → post the plan → backup → `--merge <keep> <drop> --actor <your admin user id> --apply`.
   Same for `L-5aPrumMq` + `DL-muf9zhg0-6082a02c` (E RIKSHAW). The 8 Oct visit, if on both, is cancelled on the copy (counted once).
2. Dry run of every pair: `scripts/dup-leads-last10.ts` → post count, owners, statuses. Change nothing.
3. After Kartik: the other merges; `--formats` (count of 10-digit vs +91); E-384 (`-- migration-gate: held` stays until then).
- NeoDove reconcile now matches on the last 10 digits.

### 250 / 251 / 167 — AI Analyst (built: 863701e4; E-383 db-1 only)
- 250 item 3: `scripts/verify-analyst-biplab-10nov.ts` → paste under item 3 of the change list.
- E-383 on db-2: `node scripts/_apply-e383.mjs database-2`, then Refresh tables on the prod iTarang source.
- 251 item 9 mail: Admin › Settings › Email reports › AI Analyst review → add Kartik → test → on.
- 167: post the Gemini plan (account + billing screenshot); ask the live Analyst for "a dealer's notes" and "a customer's vehicle number" (must refuse); paste into `docs/analyst/ANALYST_RO_RUNS.md` §Prod status.
- 251 item 23 (built 16 Nov): apply E-385 on live (`node scripts/_apply-e385.mjs database-2`), then on
  an answer press the envelope; next morning at 09:00 the fresh answer arrives by mail. Switch:
  Admin › Settings › Email reports › AI Analyst morning questions (on by default; only people who
  pressed the envelope are mailed).

### 253 — WhatsApp assistant (built: a6639248)
RUNBOOK §13: `scripts/list-isr-wa-bindings.ts` (post it) → Gemini billing + OpenRouter key → put the printed id list in `ASSISTANT_WRITES_ENABLED_USER_IDS` in **PROD_ENV_FILE_B64 and** the box's `shared/.env` → `pm2 reload itarang-crm-web --update-env` → brief the ISRs → tests.

### 226 — migration gate (built: 3246c808)
- The production deploy now runs `check-migrations-applied.mjs database-2 --gate` before the swap (step B.6b). First production release proves A1.1 (passes).
- A1.2 (on purpose): add a dummy `E-9xx` that creates a table, do not apply, release → stops before the swap, old build serves.
- A1.3 read-only: `ENV_FILE=.env.production node scripts/check-migrations-applied.mjs database-2` and `scripts/audit-schema.ts` → post.
- A1.4: `ENV_FILE=.env.production node scripts/list-duplicate-migration-numbers.mjs database-2` → post (42 numbers; which file is on live). Rename nothing without Kartik.

### 245 / 247 — visits (built: d2cc259f)
- 245 item 3 dry run: `scripts/catchup-assigned-visited.ts` → post the count (Jiten's 24) → Kartik → `--apply --actor <admin id>`.
- 247 item 3 dry run: `scripts/cleanup-stale-bookings.ts` (and `--owner Jiten`) → post → Kartik → backup → `--apply`.
- 247 item 1 (a saved visit closes the lead's later open bookings) is built **off**: set `VISIT_ONE_OPEN_BOOKING=1` in the env (secret + box) after Kartik approves the rule.
- Test sheet: `06_Data/247_Next_visit_check_12Nov.xlsx` against Data downloads › Leads (Next visit, Visit overdue (days)).

### 212 — missed callbacks (built: 4eb10bbe)
- Admin › Settings › Missed callbacks: switch on, recipients Sales Head + each ISR's manager.
- Submit the WhatsApp template `itarang_callback_missed`; post Meta's approval.
- Admin › Settings › AI callbacks: fill the ISR list; leave NeoDove push off; tick "Missed-callback alert by bell and email too" **after Kartik confirms**.

### 227 — held jobs (built: 52b69669)
- Post `crontab -l` and `pm2 list` from the live box (A5.1).
- After Kartik: run `GET /api/cron/nbfc-origination-maintenance?steps=flags` (Bearer CRON_SECRET) once on the sandbox → hand-off emails and flags, no wallet debit row (A5.2); then give it a runner on live.
- Ops Console › Jobs shows each held job as "Held: waiting for Kartik…" (A5.3).

### 233 — test leads (built: c0691b9f)
- Rushikesh's "Test lead" reason is the same `test_lead` code added here: coordinate so it is not added twice.
- Live test: mark one known live test lead Lost › Test lead (Admin / Sales Head / CEO) → Leads in, Lost by reason and the daily email drop by one; the Leads download still lists it as "Lost (test lead)".

### 224 / 234 / 223 — downloads and the Leads list (built: d2cc259f, a590f323)
- Leads page › Download and More › Download all now build Data downloads › Leads with the page filters (CSV above 5,000 rows; emailed when large).
- Full phone numbers for the Sales Head: **not** turned on (Apoorv's reason step pending); their file is masked.
- 223 proof: as Sales Head, download all leads; post the seconds and how it arrived.

### 244 / 236 / 237 — My visits and pop-ups (built: 06216ff6, d2cc259f)
- Test as Sonu on the sandbox, then live: opens on Me; strip "Visits today" = Today's visits tab; hot+warm+cold+not rated = Open leads; switch to My whole team → all numbers change together; overdue visits first.
- 237: Sales Head › "Jiten — visits": a photo visit shows its photo time; a visit without one shows the date and "no time recorded"; the CSV matches.

### 241-3 / 241-4 — dealer screens (built: 6428cf45)
- My dealers: "Not visited in 30 days" chip + Last visit; Data downloads › Dealer visits.

### 239 — team targets (built: be1ec6fe)
- Waits on Anirudh: reporting lines on live (194). Then as Sonu: Showing → a member → their targets and RAG; Team total → his target, members' sum, Team targets table.

### 215 — words, not codes (built: e5be0d0e)
- Targets role, invoice status ("Partly paid"), lost reasons and departments in words. Compare with Kartik's wording file when shared.

### 243 — table sort (built: 49c6b3b4 shared control; bb158d66 first lists)
- Rushikesh can move his lists onto `useUrlTableSort` / `lib/http/sortParam.ts` now.
- Still to move (Aditya): Admin › Accounts, CEO › Invoices / Accounts Receivable, Expense tracker, AI dialer campaigns and calls, Analyst review page, Ops Console › Jobs.

## Proof-only IDs (code was already built; nothing new)

| ID | What to post | How |
|---|---|---|
| 85 | L2 above | |
| 70 | L9 above | Dealer Health: a Zoho-only dealer no longer "Never ordered" |
| 194 | switch on My Day emails | after reporting lines on live (Anirudh); Admin › Settings › My Day Emails › test "as" an ASM (Monday: names Saturday) |
| 198 | two test sends | test "as" Sonu → own + "My team"; an ASM with no reports → one email |
| 188 | waits for Anirudh's format | then test send; Monday wording |
| 200 | E-368 on live (dry run first), then Finance's first upload | each people step as it happens (5 lines) |
| 201 | the five KYC history checks | screenshots |
| 203 | 5 cold loads of Admin › Accounts | network-tab times |
| 220 | `scripts/verify-dispatch-to-sold.ts` on db-2 | moved / failed on 6 Nov; SMS from the pm2 log (`cron-delivered-`) |
| 211 | part of L17 | |
