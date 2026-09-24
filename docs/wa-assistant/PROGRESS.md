# WA Assistant — Progress

One section per gate. Plan: [PLAN.md](PLAN.md).

## Gate 0 — dealer-flow `phone_number_id` guard

Commit 1b1f74c0 on `Aditya`. Ships before the assistant number receives any message (BRD §10 Day 0).

### What shipped
- `src/lib/whatsapp/types.ts` — `InboundEvent.phoneNumberId?` (Meta `metadata.phone_number_id`).
- `src/lib/whatsapp/meta.ts` — `parseInbound` stamps `phoneNumberId` on every message **and** status event, per `change` (so a mixed batch is split correctly); new pure `isForPhoneNumber(event, id)`.
- `src/app/api/whatsapp/webhook/route.ts` — 5 lines: events whose `phoneNumberId` ≠ `META_WA_PHONE_NUMBER_ID` are logged and skipped **before** `recordInbound()` and `runTurn()`, so a foreign event never touches `whatsapp_messages`, a dealer session, or a reply.
- `src/lib/whatsapp/__tests__/phone-number-guard.test.ts` — 4 tests.

### Pass-through rules (deliberate)
- `META_WA_PHONE_NUMBER_ID` unset → everything passes (today's behaviour; the dealer bot cannot send without it anyway).
- Event without `phoneNumberId` → passes. The dry-run adapter (`WA_DRY_RUN=1`, `dry-run.ts:102`) emits events with no metadata; dropping them would break the dry-run dev flow and `verify:whatsapp-journey`. Real Meta payloads always carry `metadata`.

### Test evidence
| Command | Result |
|---|---|
| `npx vitest run src/lib/whatsapp/__tests__/` | 10 files, 99 tests passed (4 new) |
| `npx vitest run` | 4756 passed, 3 skipped; 2 files failed — `src/lib/storage/__tests__/filesProxyRef.test.ts`, `src/lib/storage/drive-mirror.test.ts`, the known baseline (unset `STORAGE_BACKEND`), unrelated |
| `npx eslint <4 touched files>` | 5 errors, all pre-existing `no-explicit-any` (meta.ts 2, route.ts 3 — identical count on `HEAD`); 0 in changed lines |
| `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit --incremental false` | 6 errors, all pre-existing and unrelated (5 stale `.next/types/…` route artifacts + `tests/e2e/nbfc/E-005_…api.spec.ts`); 0 in `src/`, 0 in touched files |

Test-first: the new test file failed 4/4 before the implementation, passes 4/4 after.

### Deviations from the plan
- The plan said "log a warning when the env is unset". Not done: it would log on every delivery. Only a *dropped* event is logged.

### Open questions / notes
- Pre-existing, not touched (outside blast radius): the dealer webhook's `TEMP DEBUG` block runs before the signature check (`route.ts:39-63`), and `WHATSAPP_WEBHOOK_INSECURE` is honoured in production (`meta.ts:52`). Worth a separate ticket.
- Gate 0 "done when": **guard live in production before the new number receives a message.** That needs `Aditya` merged and deployed (push to `production`); I have not pushed anything.

## Gate 1 — fixes + skeleton

12 commits on `Aditya`, one concern each; not pushed. (All Assistant work lives on `Aditya` — no separate branches.)

### What shipped
| Commit | Concern |
|---|---|
| e8d81c5d | `src/lib/assistant/vocab.ts`: §9.3 map frozen (calls rows 1–6, visits rows 7–8, Hinglish aliases); `checkCallProposal` / `checkVisitProposal` turn anything outside the map into a question |
| 1f098234 | `recordVisit()` extracted from the ASM visit route; visit row + touchpoint now in **one** transaction (they were two) |
| 0d1a4341 | **CRM fix 1** (BRD §2.3-2): `next_visit` inserts a `scheduled` `lead_visits` row in the same tx, via reusable `scheduleVisit()` |
| f7981fb3 | `setInterestLevel()` extracted from the interest-level route |
| 7bf26899 | **CRM fix 2** (BRD §2.3-3): interest-level route calls `assertOwner()`; non-owner → 403 |
| a6b33bef | **CRM fix 3** (D4): `claimLead()` atomic (UPDATE + touchpoint in one tx, optional tx handle); an ASM claim sets `asm_id` |
| b0983185 | `drizzle/E-306_wa_assistant.sql` (committed as E-305, renumbered — see Gate 2) (5 new tables), `schema.ts` mirror (+150 lines, new tables only), checklist row |
| fafdcdf7 | `src/lib/wa-assistant/{env,verify,parse,client}.ts` |
| 154a435f | webhook route, router, identity, link, message log, fixed replies, runtime wiring, INV7 isolation contract test |
| dcae603c | Link WhatsApp page + `/api/assistant/link`, `/settings` protected in middleware, sidebar item (asm/ISR only), `.env.example` + `.gitignore` exception |
| 080e4d1c | `scripts/verify-wa-assistant.ts` (sandbox, prod-refusing) + interest-route ownership contract test |
| 030429bf | type-check fixes in my own Gate 1 code (no runtime change) |

**E-306 (then named E-305) applied to sandbox (database-1) on 2026-09-24**, on your instruction: applied twice (second pass a no-op), objects verified on a fresh connection. **Not applied to prod.** Checklist row ticked for db-1/sandbox only.

### Test evidence
| Command | Result |
|---|---|
| `npx vitest run src/lib/assistant src/lib/wa-assistant src/lib/asm src/lib/inside-sales src/lib/leads/__tests__/interestLevelRoute.contract.test.ts` | all pass (vocab 21, channel 17, router/link/identity 18, isolation 4, recordVisit 8, claimLead 4, contract 2) |
| `npx vitest run` | 4826 passed, 3 skipped (+70 new); only the 2 known `src/lib/storage` baseline files fail |
| `node --import tsx --env-file=.env.local scripts/verify-wa-assistant.ts --gate 1` (sandbox, after E-306) | **13/13 PASS** — next visit in Today's Schedule; recordVisit and claimLead roll back fully; ASM claim sets asm_id, ISR's doesn't; dedupe; LINK binds and names user + role; codes single-use; re-link revokes the old binding; 5 wrong codes then locked; unlinked / other-role / inactive → UC-13 only (binding revoked); voice note → UC-14; receipts never move backwards. Fixtures verified gone afterwards (0 rows). |
| `npx tsc --noEmit` (8 GB) | 6 errors = the Gate 0 baseline (stale `.next/types` + one e2e spec); 0 in `src/` |
| `npx eslint` on every file this branch touched | 0 errors; `sidebar.tsx` 21 pre-existing (identical on HEAD), `schema.ts` 2 pre-existing warnings |

### "Done when" status
- A next visit logged on screen appears in Today's Schedule: **yes** (G1.1, through the same `recordVisit` the route calls).
- Unlinked numbers and other roles get only the fixed reply: **yes** (unit + G1.10/G1.11 on sandbox).
- Linking works end to end **on the Meta test number**: **not yet run.** The code path is proven on sandbox with the router driven directly (G1.7). The real round trip needs Meta setup (Day 0) plus `WA_ASSIST_*` in sandbox's `shared/.env` and a deploy — see open questions.

### Deviations from the plan
1. `claimLead` sets `asm_id = actor` for an ASM claim, **not** `COALESCE(asm_id, actor)`. An unowned lead can still carry the `asm_id` of an ASM who released it, and COALESCE would keep that stale ASM, so the claimer's visits would still miss Today's Schedule.
2. A next visit is scheduled only **strictly after** the visit date. On the same day, the queue's latest-visit lateral (`ORDER BY COALESCE(actual_visit_date, scheduled_date)`) ties the visited row with the scheduled row, so the lead would appear in Today's Schedule at random.
3. New optional env `WA_ASSIST_DISPLAY_NUMBER` (display only, for the link page). It is not in the prompt's list.
4. The boot-time env check in `instrumentation-node.ts` moves to Gate 4, with the sweep ticker. For now the webhook logs and answers 503 when misconfigured.
5. Until Gate 2 and Gate 4, taps are logged (`tap_ignored`) and linked users' text gets a fixed "being set up" reply.
6. No `npm run verify:…` alias, to avoid churn in `package.json`. Run the node command above.

### Surprising contracts found (reported, not changed)
- `ForbiddenLeadAccessError` has no `.status` (`ownership.ts:12`), so `withErrorHandler` (`api-utils.ts:56-84`) turns it into a **500 "Internal error"**. Today every other mutate route (mark-lost, touchpoint, visit) answers a non-owner with a 500. I mapped it to 403 locally in the interest route only.
- The `visited` row's default `actual_visit_date` is the **UTC** date (`new Date().toISOString()`, preserved from the route), so a visit logged 00:00–05:30 IST is dated yesterday.
- `scheduleVisit`'s duplicate check has no unique index behind it. Two different users scheduling the same lead on the same day at the same instant could both insert. The Assistant's path is serialised per user.

### Open questions
- **Sandbox env for the real LINK test.** Per team memory, sandbox reads `shared/.env` on the box, and deploys never overwrite it. Someone needs to add `WA_ASSIST_*` (Meta test number id, token, app secret, verify token) there and `pm2 reload sandbox-web`. Then set the test number's webhook override to `https://sandbox.itarang.com/api/assistant/wa/webhook`. I can't do either (no SSH, no Meta access).
- When to push `Aditya`: any merge to `main` redeploys sandbox. Gate 0's guard must be live in production before the new number receives a message.
