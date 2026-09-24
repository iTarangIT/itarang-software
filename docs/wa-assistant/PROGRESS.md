# WA Assistant — Progress

One section per gate. Plan: [PLAN.md](PLAN.md).

## Gate 0 — dealer-flow `phone_number_id` guard

Branch `wa-assist/g0-dealer-guard` (off `origin/main` @ c28ace75). Its own PR, ships before the assistant number receives any message (BRD §10 Day 0).

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
- Gate 0 "done when": **guard live in production before the new number receives a message.** That needs this PR merged and deployed (push to `production`); I have not pushed anything.
