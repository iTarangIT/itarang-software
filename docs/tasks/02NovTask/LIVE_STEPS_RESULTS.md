# 2 Nov sheet (Aditya tab): live steps and checks, 4 Nov 2026

All prod (db-2) commands were run by Aditya from this machine; sandbox (db-1) by Claude.
State check for any database: `node --import tsx --env-file=<env> scripts/verify-02nov-live-state.ts`.

| Item | What was run (db-2 unless stated) | Result |
|---|---|---|
| Migrations | `verify-02nov-live-state.ts`; `node scripts/_apply-e369.mjs database-2` (and database-1) | E-369 applied on both DBs 4 Nov (pass 2 no-op, fresh-connection check). E-362 (29 Oct), E-366..E-368, E-370 present. Checklist ticked. |
| L1 NeoDove | state check | Calls reach live: 197 in 3 days, newest 4 Nov 06:17 UTC. |
| L2 / 85 | state check + `verify-id85-86-time-limits.ts` | Clean-up was applied 28 Oct; 0 lead-wide misses charged to a person; every check PASS. Sandbox: dry run, then `--apply` 4 Nov (138 cleared and re-recorded, per-person MTD unchanged). |
| 85 code | main c7be4650, production bfdf01a6 | Finished waits keep their holidays; email "Hot past" = CEO card; queue cues follow the holder. |
| 70 / L9 | state check | 125 of 126 Zoho invoices have lines (done 28 Oct). |
| L16 / 71 | state check | 0 credit notes on live, no Drive folder: nothing to fill in yet. |
| L19 / A16 | `verify-section3-report-places.ts` | No line left to stamp on live. Sandbox: 2 family keys written 4 Nov. |
| 167 / L3 / 148 / 184 / 185 | `verify-section3-report-places.ts` | All PASS: analyst_ro exists, withheld columns unreadable, live dealers 76 = 76, GSTIN missing 11 = 11, card Hot first, Dealer visits = distinct dealers. |
| 194 / 198 | state check | My day ON for ASM + ISR since 27 Oct; 3 reporting lines under 1 manager. |
| 203 | `verify-accounts-list-perf.ts` | Page 1 24 ms, counts ≤ 3.5 ms, suggested owners 108 ms, E-357 indexes 4/4. |
| 206 | state check | 61 sign-ins recorded in 2 days. |
| 217 | `verify-receivables-one-rule.ts` | Card = page header = age buckets = ₹3,32,75,595 across 96 invoices. |

## Left for a person
- **188**: Anirudh's yes on the Daily Sales email layout.
- **L17**: one live WhatsApp voice-note test with Sonu or Nidhi.
- **207**: Kartik tells the CEO that the AI connect % is lower from 28 Oct, past periods included.
- **167**: confirm the Analyst's Gemini key is on a paid plan (Google AI Studio › Billing).
- **203**: optional browser timing of 5 cold loads of Admin › Accounts.
