# 17 Oct task sheet — how each item is checked

T2.1 (13 Oct call): every re-check runs against **production**, read-only, as
well as sandbox. Every script below is read-only unless marked
**writes (sandbox only)**.

```bash
# sandbox (db-1)
node --import tsx --env-file=.env.local      scripts/<script>.ts
# production (db-2), read-only
node --import tsx --env-file=.env.production scripts/<script>.ts
```

| Sheet row | Script | Proves | Result 16 Oct |
|---|---|---|---|
| 85 / 86 | `verify-id85-86-time-limits.ts` | New limits resolve. Sat 18:00 → Mon 13:00. Every passed clock has a fixed record. Misses charged to the owner when they fell due. Inferred owners kept out of per-person counts. Dated limits: SQL = TS. Holiday log present. | db-1 PASS (needs E-343; prod pending) |
| 85 / 86 | `verify-id85-86-exports.ts` | Visits and Quotes downloads carry the clock columns and agree with `lead_clocks`. | db-1 PASS |
| 192 | `verify-id192-idle.ts` | Role limits (ISR 5 / ASM 7). Parked leads (follow-up > 30 days) are not idle. A reassigned lead is not idle for its new holder. Email = CEO = Needs Attention. | db-1 PASS, db-2 PASS (77 idle) |
| 11 | `npx vitest run src/lib/dashboard/__tests__/businessTypeParams.test.ts` | An old `finance` link reads as Battery sale. No route reads `business_type` raw. | PASS |
| 130 | `npx vitest run src/lib/security` | Constant-time compares, no default bypass secret, crons fail closed. | PASS (the separate ID 119 contract test was already red before this work) |
| A14 | `verify-a14-batteries.ts <name> <YYYY-MM>` | Dashboard batteries and revenue = the rep's invoice lines. | db-1 PASS (Sonu, Sep) |
| A26 | `verify-a26-revenue.ts [day]` | Targets actual = daily email for every rep. | db-1 PASS |
| 71 | `verify-id71-credit-notes.ts` | Money owed nets credits. Orders exclude them. Folders filter right. Fill-in runs recorded. | db-1 PASS, db-2 PASS |
| 71 | `verify-id71-credit-note-e2e.ts` **writes (sandbox only)** | A credit note for 2 batteries drops batteries sold, By SKU and gross margin by 2. Everything restored after. | db-1 PASS |
| 167 | `DRY_RUN=1 node --env-file=… scripts/_create-analyst-readonly-role.mjs` | What the Analyst login can read. | db-1 applied; **db-2 has no `analyst_ro` role** |
| 185 | `verify-id185-visits.ts [from] [to]` | Visits = Fresh + Repeat per person. Drill lists match the card. | db-1 PASS, db-2 PASS |
| A22–A24 | `verify-a22-a24-analyses.ts` | Every check on Cohorts, Turnaround and AI outcomes holds. | db-1 PASS, db-2 PASS |
| A32 | `verify-a32-endpoint-store.ts` **writes (sandbox only)** | Endpoint stored encrypted, resolves for its own campaign only, last 4 shown. | db-1 PASS |
| A32 | `replay-neodove-events.ts --since=2026-10-06 --to=…` (dry run) | Lists the calls one CRM received and the other missed. | 860 events on db-1 since 6 Oct |
| A34 | `verify-assistant-parity.ts` | WhatsApp assistant hot / warm / cold and queues = the CRM screens. | db-2 PASS (7 users, 222 rows) |

Not covered: a weekly masked copy of prod into sandbox (T2.1's second half).
That is infrastructure work, not code, and is left for a decision.
