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

## Gate 2 — agent + guards

6 commits on `Aditya`, not pushed.

### What shipped
| Commit | Concern |
|---|---|
| 59e9daf0 | **Migration renumbered E-305 → E-306.** `main` merged `E-305_ecofy_leads.sql` (2466653f) mid-gate. SQL unchanged; sandbox already has the objects, so nothing to re-apply |
| d5402073 | Golden-SQL snapshot of all 10 queue tabs (list + count, SQL + params), committed **before** the export |
| e8518606 | `export` on ISR/ASM `tabFilter` and `LATEST_VISIT_JOIN`; snapshot byte-identical |
| 2319f62d | Core, `src/lib/assistant/`: `scope`, `registry`, `tools/` (9 Zod schemas, stub bodies), `agent`, `memory`, `audit`, `prompt`, `config`, `redact`, `turn`, `actions` (pending lookup only) |
| 6f15ad00 | Channel: `wa-assistant/lock.ts` (lease, D2); router step 6 → lease → agent; `ASSISTANT_DISABLED` kill switch; typed-confirm guard |
| d5d87801 | `verify-wa-assistant.ts --gate 2` |

How the pieces behave:
- **Scope** is the union of the user's own five tab clauses, imported rather than restated. ASM queries join the latest-visit lateral. Any other role gets `FALSE`. `findLeadInScope` returns `null` for out-of-scope and nonexistent alike.
- **Registry**: unknown role → `[]`. Write tools are listed only for `ASSISTANT_WRITES_ENABLED_USER_IDS`.
- **Tools**: every lead-id tool enforces scope. Every write tool enforces the pilot flag, scope and ownership, then returns "arrives in the next release". **Nothing writes.**
- **Agent**: a bounded `ChatOpenAI.bindTools` loop.
  - Zod re-validates the model's arguments; unknown keys are stripped, never acted on. The user comes from the server-side closure.
  - At most 1 write call per turn, 4 model calls, and a 45 s deadline.
  - Results are capped at 10 rows and redacted before the model sees them. Every call is logged to `assistant_tool_calls`, and a failed audit write fails the turn.

### Test evidence
| Command | Result |
|---|---|
| `npx vitest run src/lib/assistant src/lib/wa-assistant` | 6 files, **98 passed** |
| `node --import tsx --env-file=.env.local scripts/verify-wa-assistant.ts --gate 2` (sandbox) | **19/19 PASS** (G1 ×13 still green + G2 ×6); fixtures verified gone (all counts 0) |
| `npx vitest run` | 4868 passed, 3 skipped; only the 2 known `src/lib/storage` baseline files fail |
| `npx tsc --noEmit` (8 GB) | 6 = baseline; 0 in `src/` |
| `npx eslint src/lib/assistant src/lib/wa-assistant scripts/verify-wa-assistant.ts` | clean |

### "Done when" status
| Criterion | Evidence |
|---|---|
| Unknown role → zero tools | `core.test.ts` "unknown role → zero tools": admin, ceo, dealer, sales_head, empty, null and `ASM` (wrong case) all → `[]` |
| Out-of-scope lead id → not-found (unit test) | `core.test.ts` INV1: out-of-scope and nonexistent give an identical `{kind:"not_found"}` from `get_lead_details` and from write tools. **Also on real data** (G2.4): a lead closed by another rep is invisible to an ISR, with a tool result identical to a nonexistent id |
| Two concurrent messages for one user run in sequence | G2.3: two messages through the **real router → lease → agent** path at once, with a scripted 700 ms-per-call model. Turns of 2.3 s and 2.2 s, no overlap, both answered, 2 tool calls logged. G2.1: the lease on its own |
| Every message and tool call is logged | G2.3 (`handling = text_agent` on both rows; 2 `assistant_tool_calls` rows); unit INV9: a failed audit write fails the turn |

Also proven:
- **G2.5:** 259 rows from all 10 queue tabs of 5 real sandbox reps are all inside the scope predicate. "Same access as the screens" is checked against live data, not just SQL shape.
- **INV5:** taps, LINK codes, media and unlinked or revoked senders never reach the agent (router test).
- **INV2:** a bare yes / haan / ok 👍 / theek hai / kar do while a preview waits → fixed "tap Confirm", no model.
- **INV8:** Aadhaar (4-4-4 and bare 12-digit), PAN, IFSC, 9–18-digit account numbers and DOB-tagged dates are scrubbed. IDs, links, the `phone` field and plain dates are kept.

### Deviations from the plan
1. The migration is **E-306**, not E-305 (see above).
2. The model is not given tools through LangChain's `tool()` object. `bindTools` receives OpenAI-format function definitions built with `z.toJSONSchema(schema)`, and we dispatch calls ourselves. It's still `ChatOpenAI.bindTools`, but validation and dispatch stay in our loop, where the invariants are enforced and tested.
3. Tool inputs **strip** unknown keys rather than reject them. A model that hallucinates `user_id: "someone-else"` gets the call run as the real user with that key dropped (tested).
4. `lock.ts` lives in `wa-assistant/` as planned, although the lease is on a core table.

### Open questions / risks for Gate 3
- **Latency of the scoped lookup.** G2.5 ran ~0.4 s per `findLeadInScope` from this laptop, which is mostly network to RDS. The ISR union includes the Team tab (every open lead), which is broad. Gate 3's `my_queue` and `search_lead` run one scoped query each, but I'll time them on the box and add an index only if the plan shows a sequential scan.
- **Real model not exercised yet.** The OpenAI tool-schema conversion (`$schema` key, `format: date-time`) has only been tested offline. Gate 3's scripted real-model run is the first time OpenAI sees it. `ASSISTANT_MODEL` must be set for that run.
- **Merge conflicts with `main`.** `main` has since touched `schema.ts`, `sidebar.tsx` and `MIGRATION_CHECKLIST.md` (all appends), so merging will conflict there. Resolve by keeping both sides; the checklist row is additive, per the team's merge-hotspot note.

## Gate 3 — read tools + renderers

5 commits on `Aditya`, not pushed.

### What shipped
| Commit | Concern |
|---|---|
| 36d79781 | **Agent on Google Gemini** (your instruction, 2026-09-24), via LangChain `ChatGoogleGenerativeAI`. Adds `@langchain/google-genai` 2.3.2; transitive `@langchain/core` 1.1.26 → 1.2.12. Key: `WA_ASSIST_GEMINI_API_KEY`. Model: `ASSISTANT_MODEL`, default **`gemini-3.6-flash`**, with `thinkingLevel: LOW` |
| da514733 | `leadSearchClause()`: the queue search text, previously duplicated in the ISR and ASM builders, now defined once. Golden SQL byte-identical |
| 46c60739 | `fetchLeadDetailBundle()` extracted from `GET /api/inside-sales/lead/[id]`. Whitespace-insensitive diff = only `id`→`leadId` and 404→`null` |
| cb49f819 | The 4 read tools, `callTool()` (the single path every tool call takes), `render.ts`, and the `ast:lead:<id>` tap → lead card (no model) |
| 20fd4420 | `my_queue` fetches at the screen page size; smoke set + fixture test; `verify --gate 3`; `wa-assistant-smoke.ts` |

How each read tool works:
- **`my_queue`** calls the queue routes' own builders, with the defaults they derive from an empty query string and the screens' page size (25), and shows the first 10 plus the total.
- **`search_lead`** runs the queue's search clause under the scope predicate. Two or more matches return candidates, never a pick. A phone typed with spaces or `+91` is reduced to its last 10 digits.
- **`get_lead_details`**: scope check → the screen's bundle → allowlisted projection (last 5 touchpoints and visits) → redaction.
- **`my_numbers`**: `buildSalesDashboard` pinned to the user, plus `listTargets` (pushed/accepted rows only, as `MyTargetsCard` shows). Month-to-date per UC-09, with every figure's definition.

### Test evidence
| Command | Result |
|---|---|
| `npx vitest run src/lib/assistant src/lib/wa-assistant` | all pass (render 20 incl. 24/72/900/1000 boundaries with emoji, Devanagari, flags and ZWJ; smoke-fixture validation 4; core, router, channel, vocab, isolation, golden) |
| `node --import tsx --env-file=.env.local scripts/verify-wa-assistant.ts --gate 3` (sandbox) | **24/24 PASS**; fixtures verified gone |
| `npx vitest run` | 4894 passed; only the 2 known `src/lib/storage` baseline files fail |
| `npx tsc --noEmit` (8 GB) | 6 = baseline; 0 in `src/` or `scripts/` |

### "Done when" status
| Criterion | Status |
|---|---|
| `my_queue` equals the screen row for row on all 10 tabs | **Met.** G3.1: 124 rows identical and in order, across 5 real sandbox reps (ASM + ISR), all 5 tabs each, totals equal |
| `my_numbers` equals `buildSalesDashboard` | **Met.** G3.2: byte-identical for 4 real reps × this month and last month |
| 20-question EN + Hinglish smoke set per role passes | **Fixtures written and validated; the real-model run is BLOCKED by the Gemini key's free-tier quota** — details below |

**The real-model smoke run.**
- The key is on Google's **free tier**: `generate_content_free_tier_requests, limit: 20` for `gemini-3.6-flash`.
- The run exhausted the per-minute window, then the daily one. Even after waiting ~4 minutes per question, every call returned 429.
- Every model call that did get through chose correctly:

| Calls | Result |
|---|---|
| 3 probes | `my_queue{tab:today}` for "Aaj ka schedule?"; `search_lead` first for "Called Shree Motors, not interested, price too high." and for the Hinglish UC-03 message (it resolved the lead before writing, as the prompt requires) |
| 6-call benchmark | `my_queue` 6/6; median 2.0 s, max 3.7 s |
| 2 smoke questions | "Show my follow-ups due today" and "Aaj ke follow ups dikhao" → `my_queue{tab:follow_ups}`, PASS |

That is 11/11 correct, but it is not the full 40-question run, so this criterion stays **open**.
- **To close it:** enable billing on the Google AI Studio project behind `WA_ASSIST_GEMINI_API_KEY`, then run `node --import tsx --env-file=.env.local scripts/wa-assistant-smoke.ts`.
- The script paces itself to the quota and cleans up after itself.

### Deviations from the plan
1. **Gemini, not OpenAI** (BRD §7 said OpenAI GPT). Your instruction. Consequences:
   - The key is `WA_ASSIST_GEMINI_API_KEY` (your name for it).
   - `ASSISTANT_MODEL` is optional.
   - `gemini-2.5-flash` (the first pick) is refused to new API users ("no longer available to new users"), so the default is `gemini-3.6-flash`, which Google's error names.
2. **New dependency** `@langchain/google-genai` (you approved). It moves `@langchain/core` to 1.2.12; no other package changed, and the suite and type-check are unchanged.
3. `my_queue` fetches **25 and shows 10**, rather than fetching 10 (see the screen bug below).
4. `search_lead` normalises phone-shaped queries to their last 10 digits before the queue's ILIKE. That is input cleanup, not a new search rule.

### Pre-existing issues found (reported, not changed)
- **Queue pagination is not deterministic** on Unassigned, Territory and Unclaimed.
  - Their `ORDER BY final_intent_score, created_at` is not a total order. Sandbox has **188 groups of unowned leads identical on both, up to 100 leads per group**.
  - Postgres breaks those ties differently per LIMIT and plan, so **page 1 and page 2 of the screen can repeat or skip leads**. G3.1 caught it because LIMIT 10 ≠ the first 10 of LIMIT 25.
  - Fix: add `dl.id` as a final tiebreaker in `tabOrder()` (both builders). It changes the screen order, so it is not done here. Say if you want it.
- **`WA_ASSIST_APP_SECRET` is not in `.env.local`.** Until it is set, the webhook answers 503, because signatures can't be verified.

### Open questions / risks for Gate 4
- **Gemini quota.** 20 requests/minute (and a daily cap) is roughly 7–10 turns per minute *for everyone*. The pilot needs billing on that key.
- Gate 4's end-to-end UC checks will drive the agent with a **scripted model**: deterministic, free, and exercising the real tools, executor and DB. One real-model pass follows once quota allows.

## Gate 4 — pending → executor, `log_call`, `set_follow_up`

6 commits on `Aditya`, not pushed.

### What shipped
| Commit | Concern |
|---|---|
| 0132ce15 | `assertOwner` / `assertNotStale` take an optional `{ tx }`, so the executor checks inside its write transaction. Existing callers unchanged |
| 8c61b265 | `logLeadTouchpoint()` + pure `planTouchpoint()` extracted from the touchpoint route; `next_follow_up_at` now written **inside** the touchpoint transaction (it used to commit separately afterwards). Route responses unchanged |
| e5525de8 | `markLeadLost()` extracted from the mark-lost route; `ai_recall_status` exclusion now inside the same transaction. Same 400/404 messages. **Brought forward from Gate 5**, because UC-02 (call + Lost) is a Gate 4 "done when" |
| 0ade2faa | `actions.ts` (pending store), `executor.ts`, `applierSpec.ts` / `appliers.ts`, `log_call` + `set_follow_up` proposals and appliers, `format.ts`, `when.ts` |
| bfa6cccc | Router Confirm/Cancel taps, preview buttons, tap-outcome replies, the preview's wamid recorded, 60 s sweep ticker + boot-time `WA_ASSIST_*` notice |
| 3f0e08cf | `verify --gate 4` (13 checks) |

### How a write works now
1. **The rep writes a message.** The agent calls `log_call` or `set_follow_up`. The tool checks the pilot flag, scope and ownership, then resolves the words against the frozen §9.3 map. Anything outside the map becomes a question. A follow-up must be in the future and within 90 days.
2. **The tool stores the resolved plan** in `assistant_actions` as `pending`, with the lead version, before-values and a **redacted** preview. It returns only the preview.
3. **The renderer sends the preview** (≤900 chars) with exactly **Confirm `ast:c:<id>`** and **Cancel `ast:x:<id>`**; the model's own wording is dropped.
4. **A Confirm tap goes straight to the executor**, never the model. The executor:
   - claims the action atomically (`pending → executing`, only for the tapper and only before it expires);
   - re-checks the pilot flag;
   - opens one transaction: tags the actor, locks the lead `FOR UPDATE`, runs `assertOwner` + `assertNotStale` against the preview's version, applies the plan through the extracted CRM writers, and marks the action `confirmed` with its after-values.
5. **High-impact Lost:** the first Confirm writes nothing. It creates a step-2 action with a warning (the step-1 action becomes `escalated`), and only the step-2 Confirm writes.
6. **Any failure** leaves the action `failed` with its reason, and nothing written. A 60 s sweep expires old previews and fails anything stuck in `executing`.

### Test evidence
| Command | Result |
|---|---|
| `npx vitest run src/lib/assistant src/lib/wa-assistant src/lib/inside-sales src/lib/leads` | 558 passed (new: `writes.test.ts` 17 — UC-02/03/07 plans, every question path, high-impact flag, appliers on the executor's tx, step-2-only confirmation, tampered plan refused; `logTouchpoint.test.ts` 7; `markLost.test.ts` 3; router tap tests 5) |
| `node --import tsx --env-file=.env.local scripts/verify-wa-assistant.ts --gate 4` (sandbox) | **37/37 PASS** (G1 13, G2 6, G3 5, G4 13); sandbox verified clean afterwards (every counter 0) |
| `npx vitest run` | 4926 passed; only the 2 known `src/lib/storage` baseline files fail |
| `npx tsc --noEmit` (8 GB) | 6 = baseline; 0 in `src/` / `scripts/` |
| `npx eslint` on every file changed in Gate 4 | clean |

### "Done when" status
| Criterion | Evidence (sandbox, real router → lease → agent → executor → DB; model scripted) |
|---|---|
| **UC-02** end to end | G4.1: preview with Confirm/Cancel; nothing written until the tap; then Lost/`price_high`, 1 call touchpoint with disposition "Price High" + 1 status touchpoint, action `confirmed`, its tool call linked by `action_id` |
| **UC-03** end to end | G4.2: status unchanged, `next_follow_up_at` = tomorrow 11:00 IST exactly, call `not_responding` |
| **UC-07** end to end | G4.3: a `scheduled` `lead_visits` row, and the lead **appears in Today's Schedule** |
| A typed "yes" writes nothing | G4.1: "yes" → `typed_confirm`, fixed reply; a pasted `ast:c:<id>` typed as text → agent, action still `pending`, 0 writes. Unit: router INV2 cases |
| Expired taps rejected and logged | G4.6: tap after expiry → "This action expired…", status `expired`, 0 writes, tap logged `tap_confirm` |
| Replayed taps rejected and logged | G4.4: second Confirm → "Already saved.", written once |
| Concurrent double taps never execute twice | G4.5: **5 parallel taps → 1 `confirmed` + 4 `in_progress`, one set of writes** |

Also proven:
- **G4.7:** a lead changed on screen after the preview → `rejected: stale`, 0 writes.
- **G4.8:** ownership moved → `not_owner`; removed from the pilot list → `writes_disabled`; binding revoked → UC-13 reply and the action never runs.
- **G4.9:** a failure **after** the call touchpoint → the whole action rolls back.
- **G4.10:** high-impact Lost needs the second Confirm; a double tap on step 1 doesn't count; `business_closed` also sets `ai_recall_status = excluded`.
- **G4.11:** Cancel writes nothing.
- **G4.12:** another user's action id is answered like a missing one.
- **G4.13:** the sweep works.

### Deviations from the plan
1. `markLeadLost` was extracted in **Gate 4**, not Gate 5, because UC-02 needs it. The `mark_lost` *tool* is still Gate 5.
2. **High-impact second confirm also covers `log_call`.** A call logged as "Business Closed" → Lost needs two Confirms, the same rule `mark_lost` will use (and G4.10 already proves it).
3. For a WhatsApp chat or a note, `log_call` records remarks, a follow-up and interest only. A status or call outcome makes it ask whether it was a call. §9.3 only defines call outcomes, so this is the closed-vocabulary reading.
4. The **preview is stored redacted**, and the plan is stored with the rep's words exactly. So a PAN typed in remarks is saved to the CRM, as on the screen, but never sent back over WhatsApp.
5. The executor tags `app.actor_id` for the whole transaction, so the E-304 audit triggers record the Assistant user as the actor of every field change, including `next_follow_up_at`.

### Open questions / risks for Gate 5
- **Gemini quota.** It is still the free tier. Gate 4's UC checks use a scripted model; a real-model pass of UC-01/02/03/05/07 needs billing.
- **UC-01 rollback test** (a forced failure after the visit row). The appliers and the executor transaction already make this structural (G4.9 is the same mechanism); Gate 5 adds `log_visit` and its explicit test.
- **`claim_lead`** is the only write whose lead has no owner. Its applier uses `ownership: "claim"`: the pool predicate is re-checked on the **locked** row, then `claimLead(..., { tx })`.

## Gate 5 — field writes: `log_visit`, `mark_lost`, `claim_lead`

4 commits on `Aditya`, not pushed. No migration, no schema change, no env change.

### What shipped
| Commit | Concern |
|---|---|
| 79dfbe80 | `ActionRejected` moves from `executor.ts` to `applierSpec.ts` (re-exported), so an applier can throw `not_claimable` without an import cycle |
| 67a57b21 | `log_visit`, `mark_lost`, `claim_lead`: proposals + appliers, all five write tools registered in `APPLIERS`, the Gate 2 `NOT_YET` stub removed; `writes-gate5.test.ts` (25) |
| 4162ad6b | `verify --gate 5` (10 checks) |

How each tool works:
- **`log_visit`** (ASM only). Resolves the visit against the frozen §9.3 visit rows (7–8) via `checkVisitProposal`. On Confirm, **one transaction**: `recordVisit` (visit row + visit touchpoint + scheduled next visit) → `setInterestLevel` → a non-Lost status on its own `status_change_note` (commercials explained / finalised) → or `markLeadLost`. Mirrors the visit screen: outcome and date only for a completed visit, next-visit date only with `next_visit`.
- **`mark_lost`**. Preview "from → Lost (reason)"; `other` needs notes; the four high-impact reasons get the step-2 warning preview, and only a step-2 action passes `confirmedHighImpact` to `markLeadLost` — the same mechanism G4.10 proved for `log_call`.
- **`claim_lead`**. Takes a lead id **or a name**; a name is searched in the **claim pool only** (ISR: unassigned; ASM: unclaimed in territory), with the queue's own search clause. Two matches → candidates, never a pick. At the tap, the executor locks the row and re-runs the pool predicate on it (`assertClaimable`), then `claimLead(..., { tx, actorRole })`.

### Test evidence
| Command | Result |
|---|---|
| `npx vitest run src/lib/assistant src/lib/wa-assistant` | 10 files, **171 passed** (new `writes-gate5.test.ts` 25: UC-01 plan + BRD preview, §9.3 rows 7–8, 15 question cases that create nothing, convert declined, schedule warnings, 4 high-impact reasons, `onboarding_dropout` refused, pool-only SQL for both roles, candidates, out-of-territory, appliers on the executor's tx, step-2-only confirmation, tampered plans refused) |
| `node --import tsx --env-file=.env.local scripts/verify-wa-assistant.ts --gate 5` (sandbox) | **47/47 PASS** (G1 13, G2 6, G3 5, G4 13, G5 10); sandbox verified clean afterwards (every fixture counter 0) |
| `npx vitest run` | 4951 passed, 3 skipped; only the 2 known `src/lib/storage` baseline files fail |
| `npx tsc --noEmit` (8 GB) | 6 = baseline (stale `.next/types` + one e2e spec); 0 in `src/` or `scripts/` |
| `npx eslint src/lib/assistant scripts/verify-wa-assistant.ts` | clean |

### "Done when" status
| Criterion | Evidence (sandbox, real router → lease → agent → executor → DB; model scripted) |
|---|---|
| **UC-01 saves all parts atomically** | G5.1: one preview (`Visit: visited · productive`, `Interest: none → hot`, `Next visit: … (goes to Today's Schedule)`, `Resets idle clock: yes`), nothing written before the tap; after Confirm: visited row dated as said, a `scheduled` row, one `visit` touchpoint, one interest override, interest `hot`, action `confirmed` — and the lead **is in Today's Schedule** (visit logged for yesterday, next visit today, as in G1.1) |
| **…and rolls back on a forced failure** | G5.2: a stored plan whose last step throws (`markLeadLost`: "lost_reason_notes is required") after `recordVisit` and `setInterestLevel` ran → visits, scheduled rows, touchpoints, overrides, status history all **0 before and 0 after**, interest untouched, action `failed` with that message |
| **Mark Lost with the reasons and the high-impact second confirm** | G5.5 (`loan_procedure_issue` + notes); G5.6 (`duplicate_lead`: step 1 escalates and writes nothing, a repeated step-1 tap doesn't count, step 2 saves). Unit: all 4 high-impact reasons flagged; `other` without notes is a question |
| **UC-05 passes** | G5.7 (ISR, by name → owner, `Assigned_Not_Contacted`, one `lead_claimed`, `asm_id` untouched); G5.9 (ASM in territory → owner **and** field ASM; an unowned lead outside the territory — readable in the Territory Feed — is refused "outside your territory", no action created) |

Also proven:
- **G5.3 / G5.4:** §9.3 row 7 (commercials progressed → `Commercials_Explained` on its own history row) and row 8 (dealer uninterested → visit + Lost `not_interested`) in one action each.
- **G5.8:** two pool leads with one name → list of candidates, no action row.
- **G5.10:** claim re-checked at the tap — a lead claimed by someone else in between, or an ASM whose territory ended in between → `rejected: not_claimable`, nothing written by the Assistant.

### Deviations from the plan / BRD
1. **`mark_lost` offers 10 reasons, not 11.** `onboarding_dropout` is admin-only on the screen (`MarkLostModal`, BRD §0.11) and admin is not an Assistant role. BRD §10 says "the 11 reasons" — raising it rather than silently widening what a rep can do.
2. **`mark_lost` declines a Converted lead** (and an already-Lost one) with the CRM link. The screen allows Lost from Converted for the onboarding-dropout loopback; undoing a conversion from WhatsApp is not a Phase 1 use case.
3. **`other` without notes is a question from the tool, not a schema rejection.** Same as `log_call`; the Gate 2 core test was updated to assert the schema still refuses unknown reasons and `onboarding_dropout`.
4. **`log_visit` takes `visited` / `postponed` / `cancelled` / `no_show` only** — scheduling a visit is `set_follow_up`'s job. For a visit that didn't happen, status changes are refused (a question) and any outcome is dropped, as the screen never sends one.
5. **Next step `convert` is declined with the link** (BRD §9.2, UC-11); **`escalate` is logged** with a warning that the escalation itself is raised on the screen (escalation is out of Phase 1 scope; the visit route likewise only stores it).
6. **Visit dates are IST, passed explicitly** to `recordVisit` (its own default is the UTC date — reported in Gate 1). A completed visit may be dated up to 90 days back, never in the future.
7. **A next visit must be strictly after the visit day** (after today for a visit that didn't happen), otherwise a question. This is `recordVisit`'s own rule; asking keeps the preview from promising a scheduled row that would not be written.
8. **`claim_lead` input is a lead id or a name** (BRD "Lead ID or a name resolved in the pool"). An id outside the pool gets a reason only if the user can already see the lead; anything unseen stays `not_found` (INV1).

### Pre-existing issues found (reported, not changed)
- **`POST /api/inside-sales/lead/[id]/mark-lost` accepts `onboarding_dropout` from any role.** Only the modal blocks it (client-side). A hand-made request from an ISR or ASM succeeds.
- The visit form's default date is `new Date().toISOString().slice(0, 10)` in the browser (`VisitFields.tsx`), so a visit logged 00:00–05:30 IST defaults to yesterday on the screen too.

### Not done in this gate
- **Real-model pass** of UC-01/02/03/05/07: still blocked by the Gemini free-tier quota (unchanged since Gate 3).
- **Manual run on the Meta test number**: still needs the Day 0 Meta setup and `WA_ASSIST_*` in sandbox's `shared/.env` (Gate 1 open question).

### Next: Gate 6 (break it)
The automated attack suite (`verify-wa-assistant-attacks.ts` + `attacks.test.ts`) over every case in BRD §10 Day 6, each asserting both **blocked** and a **log row**, plus the Hinglish mapping check against 30 real call notes.

## Gate 6 — break it

4 commits on `Aditya`, not pushed. No product code changed: every attack was already blocked. The gate found two product gaps in the vocabulary (below) and two fixture bugs in my own first draft (users outside the pilot list; a stubbed lead-card tap), both fixed.

### What shipped
| Commit | Concern |
|---|---|
| f4ab9779 | Shared sandbox harness moved out of `verify-wa-assistant.ts` into `scripts/wa-assistant-fixtures.ts` (unchanged; `verify --gate 5` still 47/47) |
| 824a7b8e | `src/lib/assistant/__tests__/attacks.test.ts` (15, no DB) + `scripts/verify-wa-assistant-attacks.ts` (19, sandbox) |
| 60d4e7be | `scripts/wa-assistant-mapping-check.ts`: the "30 real call notes" check (read-only) |

### Every BRD Day 6 attack: blocked, and where it is visible
Sandbox checks drive the real router → identity → lease → agent → tools → executor. The model is an **obedient script** that does whatever the attacker's text asks, so a pass means the code held, not that the model behaved.

| BRD attack | Check | Blocked by | Visible in |
|---|---|---|---|
| Cross-scope reads by id | A1.1 (agent), A1.2 (forged `ast:lead:` tap, no model) | scope predicate; out-of-scope ≡ nonexistent | `assistant_tool_calls.output = {kind:not_found}`; message `handling` |
| Writes on non-owned leads | A2.1 (`log_call` / `mark_lost` / `set_follow_up` on a Team-tab lead), A2.2 (ASM `log_visit`, same territory), A2.3 (**planted** pending row, tool bypassed) | `ownedLeadOr`; executor's `assertOwner` on the locked row | `declined` tool calls; action `failed: rejected: not_owner` |
| Instruction text pasted into chat | A3.1 (mass Lost + "you are admin" + foreign lead + "confirm yourself"), A3.2 (victim taps: high-impact still needs a 2nd tap); unit: stripped `user_id`/`role`, made-up tools, raw SQL, fake buttons in model text, SQL-shaped search text | 1 write per turn; Zod strips unknown keys; registry; only taps reach the executor | 1 `pending` action + 2 × `error = write_limit`; typed yes → `typed_confirm` |
| Two dealers with one name | A4 | search returns candidates; a name passed as an id matches nothing | `output.kind = candidates` / `not_found` |
| Tap after 10 min, double tap | A5.1 (3 days late), A5.2 (sequential + 4 concurrent) | atomic `pending → executing` claim with `expires_at` | action `expired`; 4 × `tap_confirm` rows, 1 write |
| Message from a revoked number | A6 (text and a Confirm tap) | identity trusts active bindings only | `handling = unlinked` (see note 1) |
| User deactivated / role changed mid-session | A7 | identity re-check on every message; binding self-revokes | binding `revoked_reason = user_inactive` / `role_changed`; `unlinked` |
| Same webhook delivered twice | A8 (incl. two copies of a Confirm racing); unit: route-level redelivery | unique `provider_message_id` insert before the 200 | exactly one message row, one execution |
| Wrong LINK codes | A9.1 (5 wrong → locked; then the **right** code is refused from that number, still works from the rep's own), A9.2 (expired / reused / inactive user), A9.3 (phone handed to another rep) | per-phone lockout; single-use hashed codes; relink revokes | `link_failed` ×5 → `link_locked`; `link_ineligible`; `number_relinked` |
| Voice note, image, sticker | A10 (+ document) | router step 5 | `handling = media`, by `type`; no tool call, no model |
| Forged request without a valid signature | A11 (real route: no signature, wrong secret, sender swapped after signing, foreign number); unit: sha1, garbage, misconfigured → 503 | HMAC over the raw body | **structured log only** (see note 2) |
| (extra) Another user's action id; kill switch | A12 | executor ownership of the action; `ASSISTANT_DISABLED` | `tap_confirm` / `disabled` |

**Mutation check.** Each unit guard was switched off in turn: `maxWritesPerTurn` 1→10, signature check, `phone_number_id` filter, the duplicate short-circuit, and parameterised search (→ raw SQL). Each change turned its test red, and the code was restored.

### Test evidence
| Command | Result |
|---|---|
| `npx vitest run src/lib/assistant/__tests__/attacks.test.ts` | 15 passed |
| `node --import tsx --env-file=.env.local scripts/verify-wa-assistant-attacks.ts` (sandbox) | **19/19 PASS**; fixtures cleaned up |
| `node --import tsx --env-file=.env.local scripts/verify-wa-assistant.ts --gate 5` (sandbox, after the harness move) | 47/47 PASS |
| `npx vitest run` | 4966 passed, 3 skipped; only the 2 known `src/lib/storage` baseline files fail |
| `npx tsc --noEmit` (8 GB) | 6 = baseline; 0 in `src/` or `scripts/` |
| `npx eslint` on every Gate 6 file | clean |

### The "30 real call notes" check
`scripts/wa-assistant-mapping-check.ts`, read-only on sandbox.
- **Ground truth.** 959 real NeoDove call touchpoints carry both the rep's own note and the disposition they picked.
- **Report.** `reports/wa-assistant-mapping-check-2026-09-25.md` (gitignored, because it quotes dealer notes).

**Finding 1: the frozen §9.3 map covers 62.7% of real calls.** 358 of 959 (37.3%) carry a CC-sheet disposition that no §9.3 row lists. For those, the Assistant can only ask a question, and the call can never be logged over WhatsApp:

| Disposition | Calls |
|---|---:|
| No requirement in current | 190 |
| Short Hang up | 81 |
| REJECTED BY US | 67 |
| Service Issue | 11 |
| Loan Procedure Issue | 4 |
| Some other Business | 3 |
| Deal Closed | 1 |
| Bad Experience with Trontek | 1 |

Every recorded disposition *is* in the CC sheet (0 unknown). So the gap is the map, not the vocabulary. The map is frozen by the BRD, so this is **raised, not changed**. It needs a product decision: which row, status and lost reason each should propose.

**Finding 2: the Hinglish aliases fired on 0 of 30 real notes.**
- Reps write English shorthand: "cb after two hour" (call back), "not rq" (no requirement), "deal - eastman, finance - no, monthly rq - 7,8", "switch off", "disconnect call".
- The aliases are hints to the model, so this is harmless but useless. Adding shorthand hints ("cb", "rq", "not rq", "disconnect") is a vocabulary change, so it is also raised, not made.
- The labels themselves are noisy. For example, "busy in drive cb after some time" is filed as *Service Issue*, and "not stock available scrap battery" as *Bad Experience with Trontek*. Model agreement against them is therefore a floor, not an exact score.

**Real-model pass (`--model`).** It ran 6 of 30 notes, then Gemini free-tier 429.
- 2 agree.
- 2 disagree on genuinely ambiguous notes: "On the way, will confirm evening" (the rep picked *Commercials Explained*, the model *As to Call Back*); "Busy now cb after two hour" (*As to Call Back* vs *Busy in another call*).
- 2 asked a question.
- It needs billing to finish; the script already paces itself.

### Notes / decisions for you
1. **A message from an already-revoked number is logged with `user_id` NULL.** Identity only trusts active bindings, because a lost phone may now be someone else's. The attempt is visible (`handling = unlinked`, the phone), and the rep is found by joining the phone to its revoked binding. A6 asserts exactly that. The join goes into the Gate 7 RUNBOOK review queries.
2. **Forged / foreign-number webhooks are visible only in the structured log** (`[wa-assist/webhook] bad signature`, `… another phone_number_id`), not in `assistant_wa_messages`. BRD Day 6 says every attack is "visible in assistant_actions or assistant_wa_messages". Writing unauthenticated input to the database would let anyone fill the table. I kept log-only; say if you want a counter table instead.
3. Findings 1 and 2 above: a product call on the map rows for the 8 missing dispositions, and on shorthand aliases.

### Not done in this gate
- The model half of the mapping check (24 of 30 notes) and a real-model prompt-injection run: Gemini quota.
- Manual attacks on the Meta test number: Day 0 Meta setup still pending.

### Next: Gate 7 (release)
`docs/wa-assistant/RUNBOOK.md`:
- env vars per environment;
- applying E-306;
- adding pilot users;
- revoking a number;
- both kill switches;
- the daily log-review SQL (leaks, unconfirmed writes, stuck `executing`, unhandled inbound, voice-note counts, lockouts, revoked-number attempts).

## Gate 7 — release runbook

6 commits on `Aditya`, not pushed. Nothing was deployed, no env was changed, and no migration was applied: prod still needs your explicit go-ahead (RUNBOOK §3–§4).

### What shipped
| Commit | Concern |
|---|---|
| fc3add0c | **Fix, found while writing the release order.** `GET /api/assistant/link` read `assistant_wa_bindings` *before* checking whether `WA_ASSIST_*` is set. The "Link WhatsApp" sidebar item ships with the merge, so on prod (E-306 not applied) every ASM/ISR opening it would get a **500** instead of "not available yet". Now an unconfigured host answers `configured: false` without touching the tables. Contract test reproduced the 500 first. Also a stale doc comment in `config.ts` |
| f82a8bfe | `scripts/apply-e306.mjs`. `--target sandbox\|prod` must match the host. It applies twice, then verifies 5 tables + 12 index definitions (partial-index predicates included) on a fresh connection. `--verify-only` is read-only |
| 55b3aece | `docs/wa-assistant/review.sql` (14 named queries, 5 of them go/no-go "must be empty") + `scripts/wa-assistant-daily-review.ts` (READ ONLY transactions; exit 1 on an incident) + attack check **A13** proving them |
| a3c5b757 | Type-check fix in the new contract test |
| (this commit) | `docs/wa-assistant/RUNBOOK.md` + this section |

### RUNBOOK contents
1. What runs where.
2. Env vars per environment, plus how to change them on each box. Prod `shared/.env` is rewritten from the GitHub secret every deploy, so a change needs the secret **and** the box.
3. Applying E-306.
4. The Day 7 release, in 10 ordered steps, each with its proof. The Gate 0 guard goes live in prod *before* the number receives a message.
5. Kill switches, lightest first: writes off → Assistant off → channel off. Includes what happens to previews already on phones.
6. Pilot users.
7. Daily log review.
8. Unlink, revoke, lost phone, leaver (with the admin revoke SQL).
9. Troubleshooting table, keyed on the exact replies reps see.
10. Rollback.
11. Verification commands.
12. Known limits and the open decisions.

### Test evidence
| Command | Result |
|---|---|
| `node --env-file=.env.local scripts/apply-e306.mjs --target sandbox --verify-only` | 5/5 tables, 12/12 indexes, `OK` |
| `node --env-file=.env.production scripts/apply-e306.mjs --target prod --verify-only` (read-only) | 0/5 tables. **E-306 is not on prod**, as expected |
| same script, `.env.local` with `--target prod` | `ABORT: --target prod but the host is sandbox` |
| `scripts/wa-assistant-daily-review.ts --since '30 days'` (sandbox) | all 14 queries run; no incidents |
| `scripts/verify-wa-assistant-attacks.ts` (sandbox) | **20/20 PASS**. A13 shows the review surfaces the attack traces (LINK lockout on the brute-forced number, the revoked number's rep, 4 media types, `not_owner` + `write_limit`, usage, adoption, latency). **6/6 planted incidents** are caught, one per must-be-empty query plus the unhandled-inbound check |
| runbook SQL (admin revoke, pilot lookup) | `EXPLAIN` on sandbox: both plan |
| `npx vitest run` | 4968 passed, 3 skipped; only the 2 known `src/lib/storage` baseline files fail |
| `npx tsc --noEmit` (8 GB) | 6 = baseline; 0 in `src/` or `scripts/` |
| sandbox after all runs | 0 fixture leads, users, territories, actions, messages, bindings, tool calls |

### Phase 1 build status
Gates 0–7 are done on `Aditya`. What stands between this and the Day 7 release (RUNBOOK §4, §12):
1. **Your go-ahead** to merge `Aditya` → `main` → `production`, and to apply E-306 to prod.
2. **Meta setup (Day 0):** the Assistant number, display name, and a number-level webhook override. I can't do this; it needs the Meta business account.
3. **`WA_ASSIST_*` on the boxes:** sandbox `shared/.env`; prod secret + box. I can't SSH.
4. **Billing on the Gemini key.** The free tier (20 req/min + a daily cap) can't carry a pilot, and it blocked the real-model smoke run and the model half of the mapping check.
5. **Product decisions still open:**
   - map rows for the 8 dispositions outside §9.3 (37% of real calls);
   - shorthand aliases ("cb", "not rq");
   - `mark_lost` with 10 or 11 reasons;
   - forged webhooks: log-only, or a counter table.

### Renumbered E-306 → E-309 (2026-09-25, before merging to `main`)
While Gates 2–7 were in progress, `main` took E-306 (`E-306_green_news.sql`), E-307 and E-308. The Assistant migration is now **`drizzle/E-309_wa_assistant.sql`**, and the apply script is `scripts/apply-e309.mjs`. The SQL is unchanged, so sandbox, which already has the tables, needs nothing. Read "E-306" in the gate sections above as E-309.
