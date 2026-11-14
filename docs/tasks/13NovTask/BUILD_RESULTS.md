# 13 Nov developer pack — build results (Aditya), 14 Nov 2026

Built in worktree `aditya-13nov-pack` off `origin/main` (cfce2c91); one commit per feature, each
pushed to `main` (sandbox deploy). **Not on production.** Live steps and proof: `PROOF_RUNBOOK.md`.

## Commits (main)

| Commit | IDs | What |
|---|---|---|
| 3246c808 | 226 | Migration gate (B.6b) before the production swap; `--gate`; held files; duplicate E- list |
| d91c6feb | 225 | No login password in the code; wider guard test; seeded-login check |
| 863701e4 | 250, 251, 167 | Analyst: decided starters, 10-question personal starters, name / period rules, short titles, date groups, Copy table / Download (logged), fold long questions, Monday review mail; E-383; runbook status |
| a6639248 | 253 | WhatsApp: space-blind search (also CRM Leads), dealer↔lead fallback, NeoDove guard on log_call, shorthand hints, RUNBOOK §13, ISR binding list |
| f063607f | 248 | Lead merge (keeps older, moves activity, one visit per day, copy Lost/duplicate_lead), dry-run pairs, NeoDove reconcile last-10, E-384 held |
| e5be0d0e | 215 | Words not codes: roles, invoice status, lost reasons, departments |
| c0691b9f | 233 | `test_lead` reason (Admin / Sales Head / CEO), out of every count, kept and marked in downloads |
| d2cc259f | 245, 247, 237, 224 | Real visit time in the clocks; L2 recheck of older misses; catch-up and stale-booking scripts; one open booking as Next visit + overdue days; 247 item 1 behind `VISIT_ONE_OPEN_BOOKING`; photo time in pop-ups; Leads download columns, words, remarks |
| 49c6b3b4 | 243 | Shared URL / server sort control |
| 06216ff6 | 244, 236 | My visits: Showing (manager opens on Me), numbers strip, three tabs, overdue-first groups, header sort, Last action, Claim by number button, no floating WhatsApp; Visited / Booked dates |
| a590f323 | 224, 234 | One Leads download (Data downloads › Leads); Hide box also hides Lost, hint |
| 6428cf45 | 241-3, 241-4 | Not visited in 30 days chip + Last visit; Dealer visits download |
| 4eb10bbe | 212 | Owner-less callbacks escalate and show as "No owner"; bell + email fallback switch (off) |
| 52b69669 | 227 | NBFC upkeep `?steps=flags|wallet`; "Held: waiting for Kartik" |
| be1ec6fe | 239 | Targets follow Showing; members' sum; Team targets table |
| bb158d66 | 243 | First lists keep their sort in the link |

## Gates

- Type-check (`tsc -p tsconfig.check.json`, 8 GB): clean after every commit.
- Lint on changed files: no new errors (pre-existing ones in `leads/page.tsx` 24 → 24, `AsmLeadDetailView.tsx` lines 53/64).
- Vitest: every suite touched passes. Already red on main and unchanged: `src/components/layout/__tests__/navLayout.test.ts` (3 menu line-count cases).
- Snapshots updated on purpose: queue golden SQL (search OR, then the ASM my_visits order / booking join), assistant vocab (shorthand hints).

## Sandbox runs (db-1), 14 Nov

| Check | Result |
|---|---|
| Migration gate, full (342 files) | passes; a dummy unapplied file → exit 1 naming the table; marked held → passes |
| Duplicate E- numbers | 42 |
| Seeded test logins | the three seed logins absent; 2 e2e logins, 0 can sign in |
| E-383 | applied (second pass "already applied") |
| Biplab 10 Nov query | Biplabh Ghosh matched; 0 rows (sandbox data) — run on live |
| ISR WhatsApp bindings | 3 active ISRs, 0 linked; Sonu linked |
| Space-blind search | "orientale-rickshaw" finds "oriental e-rickshaw" (old search 0) |
| Lead merge (TEST leads) | 10/10 PASS |
| Duplicate pairs / formats | 25 numbers on 2+ leads; 3191 stored as 10 digits, 1899 as +91 |
| Test lead (TEST lead) | ISR refused; CEO Leads in 1 → 0; not in Lost analysis; download "Lost (test lead)" |
| Leads download Next visit | 24 with a booking, 24 overdue (were hidden) |
| Stale bookings dry run | 9 leads, 11 bookings |
| Catch-up dry run | 0 (sandbox) |
| L2 dry run | 98 to clear (cut-off + lead-wide); older misses no longer late: 0 |
| Sales drill (Oct 1 – Nov 14) | visits 26 rows, 14 with a photo time; productive 27 / 15; verified 15 / 15 |
| My visits, Sonu | Me: 34 = 10+3+5+16 = Open leads tab; whole team 974; overdue first (49 days); booked 18 / visited 20 (1 Oct – 30 Nov); 4 header sorts run |
| Leads list Hide | default 4996, everything 5118, Status = Lost 11; "Green" → 1 hidden Lost |
| My dealers / Dealer visits | 64 dealers, 42 flagged (rest closed); TEST visit 3 days ago clears the chip and appears in the file (deleted after) |
| Missed callbacks email query | runs; 0 missed yesterday |
| verify-id70-zoho-copy | all checks passed (126/126 read; 74 of 75 customers with a GSTIN) |
| verify-dispatch-to-sold | 6 Nov moved 1, failed 0; 3-5 Nov failed 1 each (before the fix) |
| verify-id85-86-time-limits | all checks passed |

Not checked in a browser: the screens were exercised through their queries and unit tests;
Kartik's sandbox re-check (pack rule 3) is the screen check. Not built: 251 item 23 (optional),
the rest of 243's lists, Sales Head full phone numbers (Apoorv).
