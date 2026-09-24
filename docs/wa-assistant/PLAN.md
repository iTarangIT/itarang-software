# WhatsApp AI Assistant (ASM + ISR): Phase 1 PLAN

> On approval, this file is copied verbatim to `docs/wa-assistant/PLAN.md`. That copy is the first commit, then Gate 0 starts.
> Spec: `docs/ai-assistant-whatsapp/CRM_AI_Assistant_Phase1_WhatsApp_BRD.pdf`. The prompt names `docs/brd/…`, which does not exist. Read end to end, 24 Sep 2026.
> Branch base: `Aditya` == `origin/main` @ c28ace75. Highest migration was E-304 when planned; main then took E-305 (`E-305_ecofy_leads`), so this is **E-306**. I will re-check this before the Gate 1 migration commit, because parallel agents take numbers.

## Context

ASMs and ISRs log calls and visits late or not at all: two or three forms per event, on the phone, after the conversation. The BRD moves capture to WhatsApp:
- A rep messages a dedicated number.
- A LangChain tool-calling agent reads their CRM data within their exact permissions.
- Writes are proposed as a preview with Confirm/Cancel buttons and run only on a button tap.

It is a new, separate flow: its own number, route, module and tables. The only change to the dealer bot is a `phone_number_id` guard.

### Decisions you made (24 Sep, before this plan)

| # | Question | Decision |
|---|---|---|
| D1 | Router order: BRD vs prompt | **Hybrid**: signature → `phone_number_id` → insert inbound *messages* (dedupe) → 200 → `after()`. Status events skip dedupe and update the outbound row. |
| D2 | Per-user serialisation | **Lease row** on `assistant_conversations`, not `pg_advisory_xact_lock`. The pool is `max: 5` (`src/lib/db/index.ts`), so an xact lock held across an LLM turn would pin a pooled connection. |
| D3 | Integration-test DB | **Sandbox**, after you apply E-306. Scripts create prefixed fixtures and delete them. A hard guard refuses to run against the prod host. |
| D4 | ASM-claimed leads missing from Today's Schedule | **Fix in `claimLead`**: set `asm_id` when the claimer is an ASM. |

---

## (a) Files to create / modify (one line each)

The file list below is shaped by BRD §2.3, §8.3 and §10.

**Gate 0: dealer-flow guard (its own PR, ships first)**
- M `src/lib/whatsapp/types.ts`: add optional `phoneNumberId?: string` to `InboundEvent`.
- M `src/lib/whatsapp/meta.ts`: `parseInbound` stamps `value.metadata.phone_number_id` on each event; add a pure `isForPhoneNumber(e, id)` helper.
- M `src/app/api/whatsapp/webhook/route.ts`: drop and log events with a foreign `phoneNumberId` **before** `recordInbound()` and `runTurn()` (~4 lines).
- A `src/lib/whatsapp/__tests__/phone-number-guard.test.ts`.

**Gate 1: fixes + skeleton**
- A `src/lib/assistant/vocab.ts`: frozen §9.3 map, Hinglish aliases, proposal/question resolver.
- A `src/lib/asm/recordVisit.ts`: `recordVisit()` and `scheduleVisit()` extracted from the visit route, now in one tx; `next_visit` also inserts the scheduled `lead_visits` row (**CRM fix 1**).
- M `src/app/api/asm/lead/[id]/visit/route.ts`: becomes a thin call to `recordVisit()`.
- A `src/lib/leads/interestLevel.ts`: `setInterestLevel()` extracted from the interest route.
- M `src/app/api/inside-sales/lead/[id]/interest-level/route.ts`: calls it, plus `assertOwner()` (**CRM fix 2**, separate commit).
- M `src/lib/inside-sales/claimLead.ts`: optional `{ tx, actorRole }`. The UPDATE and the touchpoint run in one tx, and `asm_id = COALESCE(asm_id, actor)` when `actorRole === 'asm'` (**CRM fix 3**, D4).
- M `src/app/api/inside-sales/lead/[id]/claim/route.ts` and `src/app/api/inside-sales/lead/bulk-claim/route.ts`: pass `actorRole`.
- A `drizzle/E-306_wa_assistant.sql`; M `src/lib/db/schema.ts` (mirror, new tables only); M `drizzle/MIGRATION_CHECKLIST.md` (one row).
- A `src/lib/wa-assistant/env.ts`: Zod-validated, memoised `waAssistEnv()` (see (c)17).
- A `src/lib/wa-assistant/verify.ts`: timing-safe HMAC and the GET handshake.
- A `src/lib/wa-assistant/parse.ts`: Zod-validated Meta payload → `InboundEvent[]`, including `phoneNumberId`.
- A `src/lib/wa-assistant/client.ts`: Graph `sendText` / `sendButtons` / `sendList` / `markRead`. Own env, no translation, retries 429/5xx up to 3× with jitter, and logs the outbound row and `wamid`.
- A `src/lib/wa-assistant/identity.ts`: `resolveSender()`. Self-revokes a binding whose user is inactive or has changed role.
- A `src/lib/wa-assistant/link.ts`: `issueLinkCode`, `verifyLinkCode`, `revokeBinding`, per-phone lockout.
- A `src/lib/wa-assistant/messages.ts`: insert inbound (dedupe), log outbound, apply status monotonically, set `handling`.
- A `src/lib/wa-assistant/replies.ts`: fixed reply texts (UC-13, UC-14, UC-15, errors, disabled).
- A `src/lib/wa-assistant/router.ts`: steps 4–9 from (c)2; step 10 answers "coming soon" until Gate 2.
- A `src/app/api/assistant/wa/webhook/route.ts`: GET verify; POST signature → number → dedupe insert → 200 → `after(route)`.
- A `src/app/api/assistant/link/route.ts`: POST issue code, DELETE unlink, GET current binding. Session auth; asm/ISR only; checks `is_active`.
- A `src/app/(dashboard)/settings/whatsapp-link/page.tsx` and a `_components/LinkWhatsApp.tsx` client component.
- M `src/middleware.ts`: add `path.startsWith("/settings")` to `isProtectedRoute`. One line; the page re-checks the role itself.
- M `src/components/layout/sidebar.tsx`: a "Link WhatsApp" item for `asm` and `inside_sales_rep` only.
- A `.env.example` with a WA-assistant section only. M `.gitignore`: add `!.env.example`, since `.env*` currently ignores it.
- A `scripts/verify-wa-assistant.ts`: sandbox integration checks, extended every gate, with the prod-host refusal guard.

**Gate 2: agent + guards**
- M `src/lib/inside-sales/queryBuilder.ts`: `export` on `tabFilter`. No other change.
- M `src/lib/asm/queryBuilder.ts`: `export` on `tabFilter` and `LATEST_VISIT_JOIN`. No other change.
- A `src/lib/assistant/__tests__/tabFilter-golden.test.ts`: committed **before** the export commit (see (d)).
- A `src/lib/assistant/types.ts`: `AssistantUser`, `ToolResult`, `Preview`, `PendingAction`, `TurnResult`.
- A `src/lib/assistant/scope.ts`: `scopePredicate`, `findLeadInScope`, `claimPoolPredicate`.
- A `src/lib/assistant/registry.ts`: `ROLE_TOOLS`, `toolsFor(user)`, the pilot write flag.
- A `src/lib/assistant/prompt.ts`: system prompt with role tabs, vocab, IST "now", ask-when-unsure and never-invent.
- A `src/lib/assistant/agent.ts`: `runAgentTurn()`, a bounded `ChatOpenAI.bindTools` loop (see (c)24).
- A `src/lib/assistant/memory.ts`: load/save the last 20 turns; 24 h idle reset.
- A `src/lib/assistant/audit.ts`: tool-call log and structured JSON log with masking.
- A `src/lib/assistant/redact.ts`: allowlist projection plus Aadhaar/PAN/IFSC/account/DOB scrubbing of free text.
- A `src/lib/assistant/tools/read/*.ts` and `tools/write/*.ts`: all nine Zod schemas, with stubbed bodies.
- A `src/lib/wa-assistant/lock.ts`: `withUserLease()` (D2).
- M `router.ts`: step 10 goes to lease → agent; adds the kill switch `ASSISTANT_DISABLED` and the typed-confirm guard.

**Gate 3: read tools + renderers**
- A `src/lib/inside-sales/leadDetail.ts`: `fetchLeadDetailBundle()` extracted from `GET /api/inside-sales/lead/[id]`. M that route to call it.
- Fill `tools/read/{myQueue,searchLead,getLeadDetails,myNumbers}.ts`.
- A `src/lib/wa-assistant/render.ts`: text / list / preview within the §6 limits.
- A `src/lib/assistant/__tests__/fixtures/smoke-{isr,asm}.json`: 20 EN+Hinglish questions per role.
- A `scripts/wa-assistant-smoke.ts`: one real-model scripted run.

**Gate 4: executor + first writes**
- M `src/lib/leads/ownership.ts`: `assertOwner` / `assertNotStale` gain optional `opts?: { tx }`. Backward compatible; existing callers are untouched.
- A `src/lib/inside-sales/logTouchpoint.ts`: `planTouchpoint()` (pure) plus `logLeadTouchpoint()` extracted from the touchpoint route; `follow_up_at` now inside the tx.
- M `src/app/api/inside-sales/lead/[id]/touchpoint/route.ts`: calls it; the HTTP errors are unchanged.
- A `src/lib/assistant/actions.ts`: `createPending`, `executeAction`, `cancelAction`, `sweepActions`.
- Fill `tools/write/{logCall,setFollowUp}.ts`.
- M `src/instrumentation-node.ts` and `src/instrumentation.ts`: `startWaAssistantSweepTicker()` (60 s).

**Gate 5: field writes**
- A `src/lib/leads/markLost.ts`: `markLeadLost()` extracted from the mark-lost route; the `ai_recall_status` side effect moves inside the tx. M that route.
- Fill `tools/write/{logVisit,markLost,claimLead}.ts`.

**Gate 6:** A `scripts/verify-wa-assistant-attacks.ts` plus pure attack tests in `src/lib/assistant/__tests__/attacks.test.ts`.

**Gate 7:** A `docs/wa-assistant/RUNBOOK.md`.

**Every gate:** M `docs/wa-assistant/PROGRESS.md`.

---

## (b) Existing exported signatures I will call (verbatim)

```ts
// src/lib/touchpoints/write.ts:119
writeTouchpoint(input: WriteTouchpointInput, opts?: { tx?: Tx }): Promise<WriteTouchpointResult>
// src/lib/leads/ownership.ts:43,58  (Gate 4 adds opts?: { tx?: Tx } to both)
assertOwner(leadId: string, userId: string): Promise<void>                 // throws ForbiddenLeadAccessError
assertNotStale(leadId: string, updatedAtSeen: Date): Promise<void>         // throws StaleLeadError (compares dealer_leads.updated_at)
// src/lib/inside-sales/claimLead.ts:31  (Gate 1 adds opts?: { tx?: Tx; actorRole?: string })
claimLead(leadId: string, actorId: string): Promise<ClaimOutcome>          // {ok:true} | {ok:false; reason:'not_found'|'already_owned'|'terminal'}
// src/lib/inside-sales/queryBuilder.ts:161 / src/lib/asm/queryBuilder.ts:163
fetchQueueRows({ tab, userId, page, limit, q, neodoveOnly, callbackOnly, filters, sort }): Promise<QueueRow[]>
fetchAsmQueueRows({ tab, asmId, page, limit, q, filters, visitStatus, visitOutcome, sort }): Promise<AsmQueueRow[]>
tabFilter(tab: QueueTab, userId: string): SQL          // becomes exported, unchanged (ISR :70)
tabFilter(tab: AsmQueueTab, asmId: string): SQL        // becomes exported, unchanged (ASM :39); `today` needs LATEST_VISIT_JOIN
// src/lib/admin/salesDashboard.ts:767
buildSalesDashboard(input: SalesDashboardInput): Promise<SalesDashboard>   // called with spoc_id: user.id, as both performance routes do
// src/lib/targets/service.ts:145,199
listTargets(opts: { month: string; userId?: string }): Promise<TargetRow[]>   // rows carry progress: Progress
workingDayContext(month: string)                                              // → { month, working_days_total, working_days_elapsed }
// src/lib/targets/rules.ts
TARGET_METRICS, metricsForRole(role), rag(pct), progress({...}), monthStart(iso)
// src/lib/lifecycle/transitions.ts
LEAD_STATUS, OPEN_STATUSES, TERMINAL_STATUSES, LOST_REASON (11), HIGH_IMPACT_LOST_REASONS (4), isHighImpactLostReason(r), isTerminal(s)
// src/lib/lifecycle/touchpointTypes.ts
TOUCHPOINT_TYPE, CALL_STATUS, NEXT_ACTION, isWorkedTouchpoint(type, hasStatusChange), shouldAutoEngage(type, ctx)
// src/lib/leads/dispositions.ts
CONNECT_STATUS, DISPOSITION_BUCKETS, CONNECTED_DISPOSITIONS, NOT_CONNECTED_REASONS,
classifyDisposition(raw, hints?), resolveBucket(label, fallback, hints), callStatusForDisposition(d)
// src/lib/asm/types.ts
ASM_QUEUE_TABS, VISIT_STATUS, VISIT_OUTCOME, VISIT_NEXT_ACTION, ENGAGED_OUTCOMES
// src/lib/inside-sales/types.ts
QUEUE_TABS, CLAIM_ROLES
// src/lib/auth-utils.ts:130   (does NOT check is_active)
requireRole(roles: string[]) → dbUser
// src/lib/ai/phone.ts
normalizeIndianPhone(phone): string | null      // → +91XXXXXXXXXX
// src/lib/log.ts
log.info/warn/error(msg: string, meta?)         // constant msg, variable meta (dedupe keys on msg)
// @langchain/openai 1.2.8, @langchain/core 1.1.26 (transitive), zod 4.3.5
new ChatOpenAI({ model, temperature }).bindTools(tools);  tool(fn, { name, description, schema })
```

New or extracted signatures. Each extracted route becomes a thin caller:
```ts
recordVisit(input: VisitInput & { leadId: string; asmId: string }, opts?: { tx?: Tx }): Promise<{ visitId: string; scheduledVisitId: string | null }>
scheduleVisit(input: { leadId: string; asmId: string; date: string; remarks: string }, opts?: { tx?: Tx }): Promise<{ visitId: string | null /* null = already scheduled */ }>
setInterestLevel(input: { leadId: string; actorId: string; level: 'hot'|'warm'|'cold'; reason?: string|null }, opts?: { tx?: Tx }): Promise<{ changed: boolean }>
planTouchpoint(body: TouchpointBody, fromStatus: LeadStatus|null, actorId: string): WriteTouchpointInput   // pure; throws UnknownDispositionError
logLeadTouchpoint(input: { leadId; actorId; body: TouchpointBody }, opts?: { tx?: Tx }): Promise<WriteTouchpointResult>
markLeadLost(input: { leadId; actor: { id; role }; reason: LostReason; notes?: string|null; confirmedHighImpact: boolean }, opts?: { tx?: Tx }): Promise<void>
fetchLeadDetailBundle(leadId: string): Promise<LeadDetailBundle | null>
```

---

## (c) BRD conflicts, ambiguities and surprising code contracts

Each item says what I'll do. Items 1–4 are decided (D1–D4).

1. **BRD path.** The prompt says `docs/brd/`; the file is at `docs/ai-assistant-whatsapp/`.
2. **Router order (D1).** The final order:
   1. Bad signature → 401.
   2. Foreign `phone_number_id` → ignore and log.
   3. Inbound message rows inserted `ON CONFLICT DO NOTHING`.
   4. 200.
   5. In `after()`, in order: status events → LINK → identity → kill switch → tap → media → text.

   Identity comes before taps and media, as in BRD §8.3. The prompt has taps/media after identity too. `ASSISTANT_DISABLED` sits right after identity.
3. **Lock (D2).** `assistant_conversations.lease_token` / `lease_until`.
   - Acquire: `UPDATE … WHERE lease_until IS NULL OR lease_until < now() RETURNING`.
   - Poll every 300 ms for up to 60 s, then reply "still working on your last message".
   - Lease is 90 s, the turn's hard timeout 45 s; release by token in `finally`.
4. **`claimLead` / Today's Schedule (D4).** The `today` tab keys on `dl.asm_id` (asm queryBuilder.ts:48), which claim never set. The fix is in the Gate 1 list.
5. **`claimLead` is not atomic.** The owner UPDATE commits, then `writeTouchpoint` opens its own tx (claimLead.ts:48–76). With `opts.tx`, both run in one tx; without it, the function wraps itself. **Also:** the claim route (claim/route.ts) lets an ASM claim *any* unowned lead; there is no territory check. The tool enforces the ASM `unclaimed` predicate. The route stays as is (outside the blast radius, reported).
6. **The visit route is not atomic.** The `lead_visits` insert tx commits, then a separate `writeTouchpoint` runs (visit/route.ts:77–125). `recordVisit()` does both in one tx, which also makes the screen atomic.
7. **Other writes outside their tx.** The touchpoint route's `follow_up_at` UPDATE (touchpoint/route.ts:177–184) and mark-lost's `ai_recall_status` UPDATE (mark-lost/route.ts:74–77) run outside the write tx. The extracted functions move both inside. Response codes and messages are unchanged.
8. **`assertOwner` / `assertNotStale` read through the global `db`** (ownership.ts:43, 58), so a check made before a write tx is a TOCTOU. I'll add an optional `opts.tx`. The executor runs `SELECT … FROM dealer_leads WHERE id=$1 FOR UPDATE` inside the tx, then calls both with that tx.
9. **`assertNotStale` compares `updated_at`.** The AI dialer and NeoDove bump it via `writeTouchpoint`, so a background call between preview and tap rejects the tap as stale. The reply is "This lead changed since the preview. Send it again." Accepted as the safe side.
10. **Invariant 1 vs `claim_lead`.** A pool lead has no owner, so `assertOwner` cannot apply. Claim instead re-checks eligibility inside the tx (ISR: the `unassigned` tab clause; ASM: the `unclaimed` clause) under `FOR UPDATE`, then relies on claimLead's guarded `current_owner_id IS NULL` UPDATE.
11. **Interest-route `assertOwner` fix (BRD §2.3-3)** is a behaviour change. Admin, partner, and an ASM acting on an ISR-owned lead can no longer set interest; today they can (see the route comment). Mark-lost and touchpoint already work this way. I'll ship it as the BRD asks and call it out in the commit.
12. **`requireRole` never checks `is_active`** (auth-utils.ts:130). The link API checks it explicitly.
13. **Unlink on deactivate or role change.** No admin route edits `users.is_active` or `role`. The BRD's "deactivating revokes the binding" is therefore enforced where it cannot be bypassed: `resolveSender` checks on every message and marks the binding `revoked` (`user_inactive` / `role_changed`) the first time it sees the change.
14. **The link page needs two small edits outside the BRD layout.** `/settings` is not a protected route today, so signed-out visitors aren't redirected (middleware.ts:462–488). Add one line. Also add a sidebar item so reps can find the page.
15. **`.env.example` is gitignored** by `.env*`. I'll add `!.env.example`. The file contains names and comments only, no values.
16. **Hinglish aliases.** The BRD says to add them to "the alias table", but `dispositions.ts` `ALIASES` also classifies NeoDove inbound traffic. They go in `assistant/vocab.ts`; `dispositions.ts` is not touched.
17. **"Fail fast at module load in production"** would break `next build`: it imports route modules with `NODE_ENV=production`, and CI has no `WA_ASSIST_*`. Instead:
    - `waAssistEnv()` validates lazily.
    - `instrumentation.ts` validates at startup and logs loudly without crashing the CRM.
    - The webhook fails closed: 503 if misconfigured, 401 if the secret is missing.
18. **Link lockout.** A wrong code identifies no user row, so per-binding `failed_attempts` / `locked_until` can't implement "5 wrong codes from one **number** per hour".
    - Lockout is derived from the message log: `count(*) FROM assistant_wa_messages WHERE wa_phone=$1 AND handling='link_failed' AND created_at > now()-'1h'` ≥ 5 → reply "locked".
    - It is serialised per phone by a short `pg_advisory_xact_lock(hashtext('wa-assist-link:'||phone))`, held for milliseconds, not across an LLM call.
    - `code_hash = HMAC-SHA256(code, WA_ASSIST_APP_SECRET)`, so the hash is findable by lookup and not brute-forceable offline in a 10⁶ space.
    - Codes are unique among pending rows (partial unique index); issuing a new code replaces the user's pending row.
19. **§9.3 visit rows propose status changes** (Commercials_Explained/_Finalised, Lost), but the visit route deliberately never transitions status (visit/route.ts:8–10). `log_visit` composes these in **one tx**: `recordVisit` (visit row, visit touchpoint, scheduled row) + `setInterestLevel` + optional status via `logLeadTouchpoint(status_change_note)` or `markLeadLost`.
20. **UC-02 (call + Lost `price_high`).** The touchpoint route's status change carries no lost reason. `log_call` with Lost therefore writes the call touchpoint, then `markLeadLost` (its own `status_change_note`), in one tx. That is the same two rows the screens produce.
21. **High-impact second confirm.**
    - Confirm on the stage-1 preview writes nothing CRM-side. It inserts a stage-2 action (`parent_action_id`, `step=2`, a fresh 10-min expiry, a warning preview), and stage 1 ends in a new status **`escalated`**.
    - Only a `step=2` action passes `confirmedHighImpact: true` to `markLeadLost`.
    - A double tap on stage 1 finds it no longer `pending`, so it can't count as the second confirm.

    This adds one status value to your list.
22. **A fifth table, `assistant_tool_calls`.** BRD §7 says "four new tables", which the prompt allows me to exceed with justification:
    - read tools create no action row;
    - the conversation jsonb is trimmed to 20 turns, so it cannot be the audit;
    - a tool call is not a WhatsApp message.

    Invariant 9 needs every tool call's input and output kept.
23. **Pending link codes** live as `status='pending'` rows in `assistant_wa_bindings`, with `wa_phone` NULL until verified. No link-codes table.
24. **Agent implementation.** Nothing in the repo runs a tool-calling loop yet (only fixed LangGraph pipelines). BRD says "LangChain v1 agent, no LangGraph", and `langchain` v1's `createAgent` runs on LangGraph internally. So I use `ChatOpenAI.bindTools()` with a hand-written bounded loop:
    - at most 4 model calls per turn;
    - at most 1 write tool call per turn (a second one gets "one change at a time");
    - 45 s timeout;
    - temperature 0;
    - `ASSISTANT_MODEL` is required, `OPENAI_API_KEY` is reused.
25. **Rendering.** Previews and lists are built **deterministically** from tool results and the pending row, never from model text. A preview message is exactly what will be written. The model's free text is used only for plain replies. Preview field labels stay in English (the stored values); plain replies follow the user's language.
26. **Typed "yes/haan/ok/confirm" while a pending action exists** gets the fixed reply "Tap Confirm on the preview", with no model call. Anything else typed never reaches the executor: only `ast:c:` button *interactive replies* do, and typed text beginning `ast:c:` is plain text.
27. **`my_numbers` "equal to the performance page".** That page is `MyTargetsCard` (`listTargets`, showing `pushed`/`accepted` rows) plus `SalesDashboardView` (`buildSalesDashboard({spoc_id})`, defaulting to the last 30 days).
    - BRD UC-09 asks for MTD, so the tool uses `from = month start, to = IST today`, same `spoc_id`, plus `listTargets({month, userId})`.
    - The equality test compares against those exact calls.
    - Two definitions are stated in the output: `calls_per_day` counts `inside_sales_call` only, while the dashboard's "calls" include `ai_call`.
28. **Duplicate scheduled rows.** `scheduleVisit` skips the insert if an open scheduled row already exists for (lead, ASM, date). Older open scheduled rows are not closed, which is pre-existing behaviour that the dashboard's "planned visits" counts.
29. **Today's Schedule uses `CURRENT_DATE`** (DB timezone), while the dashboard uses IST. Scheduled dates are stored as IST dates. Pre-existing; noted, not fixed.
30. **Sensitive data (Invariant 8).**
    - Tools project an **allowlist** of fields. The detail bundle doesn't select PAN, Aadhaar or bank fields, but `remarks` / `notes` are free text.
    - `redact.ts` masks 12-digit Aadhaar, PAN `[A-Z]{5}\d{4}[A-Z]`, IFSC, 9–18-digit account numbers and DOB-like dates in every free-text field, in the tool layer.
31. **BullMQ for expiry (BRD §7)** is effectively dead in production (instrumentation-node.ts:965). Instead:
    - `expires_at > now()` in the executor's atomic UPDATE is the authority;
    - an in-process 60 s ticker marks old `pending` rows `expired` and `executing` rows older than 5 min `failed` (crash recovery);
    - the "daily usage report" becomes RUNBOOK SQL.
32. **Pilot flag at two points.** `ASSISTANT_WRITES_ENABLED_USER_IDS` is checked in the registry (write tools omitted) **and** again in the executor, so removing a user between preview and tap blocks the write.
33. **`after()` durability.** The inbound row is written before the 200 (D1) and carries `handled_at` / `handling`. The RUNBOOK's "stuck turns" query flags rows unhandled after 5 min.
34. **Graph API has no idempotency key.** Retrying a 5xx could double-send a reply. That is harmless for text; for a preview it means two buttons with the same action id, and the executor runs it once. Accepted.
35. **Pre-existing dealer-webhook issues** (reported, not touched):
    - a `TEMP DEBUG` block runs before the signature check (route.ts:38–62);
    - `WHATSAPP_WEBHOOK_INSECURE` is honoured even in production (meta.ts:52).
36. **Gate 0 guard when `META_WA_PHONE_NUMBER_ID` is unset:** pass events through and log a warning. That preserves today's behaviour; the dealer bot can't send without it anyway.
37. **Sandbox tests (D3) mutate shared data.**
    - Fixtures use id prefix `WA-TEST-` and synthetic users with `wa-test+…@itarang.test`.
    - Cleanup runs in `finally`.
    - The script exits if the DB host is the prod host (db-2) or `NODE_ENV=production`.
    - The assistant tables must exist: **you apply E-306 to sandbox** before Gate 1's integration checks.

### Executor (Invariant 3), exact sequence
1. `UPDATE assistant_actions SET status='executing', updated_at=now() WHERE id=$1 AND user_id=$tapper AND status='pending' AND expires_at > now() RETURNING *`.
   - 0 rows → classify with a read-only SELECT: `confirmed` → "Already saved", `expired` or past `expires_at` → mark `expired` → "This action expired", `cancelled` / `executing` / `failed` → fixed text, not found or another user's → a generic not-found.
   - Every case logs the tap.
2. Re-check that the binding is active, the user is active, the role is asm/ISR, and the user is in the pilot list.
3. `db.transaction`:
   1. `SELECT … FOR UPDATE` on the lead;
   2. `assertOwner(tx)` (claim: the eligibility clause instead);
   3. `assertNotStale(tx, lead_version)`;
   4. the tool's `apply(tx)` (all CRM writes, `writeTouchpoint({tx})`);
   5. `UPDATE assistant_actions SET status='confirmed', after=…, executed_at=now() WHERE id AND status='executing'`.
4. On any error: `status='failed', error=…`, reply "Something went wrong, nothing was changed". A `finally` guarantees nothing is left `executing`.

### E-306 tables (all `IF NOT EXISTS`, additive; `user_id uuid REFERENCES users(id)`)

- **`assistant_wa_bindings`**
  - Columns: `id`, `user_id`, `wa_phone` (E.164 with '+', NULL while pending), `status` CHECK ∈ {pending, active, revoked}, `code_hash`, `code_expires_at`, `verified_at`, `revoked_at`, `revoked_reason`, `created_at`, `updated_at`.
  - CHECK: an active row has `wa_phone`.
  - Partial unique indexes: `(user_id) WHERE active`, `(wa_phone) WHERE active`, `(user_id) WHERE pending`, `(code_hash) WHERE pending`.
- **`assistant_conversations`**
  - Columns: `id`, `user_id`, `channel`, `messages` jsonb, `last_activity_at`, `lease_token`, `lease_until`, timestamps.
  - Unique `(user_id, channel)`.
- **`assistant_actions`**
  - Columns: `id` uuid, `user_id`, `channel`, `tool`, `lead_id`, `lead_version` timestamptz, `input`, `preview`, `before`, `after` jsonb, `status` CHECK ∈ {pending, executing, confirmed, cancelled, expired, failed, escalated}, `step` smallint, `parent_action_id`, `expires_at`, `executed_at`, `error`, `wa_message_id`, `source_message_id`, timestamps.
  - Indexes: `(user_id, status)` and `(status, expires_at) WHERE status IN ('pending','executing')`.
- **`assistant_wa_messages`**
  - Columns: `id`, `provider_message_id` UNIQUE (nullable for failed sends), `direction`, `type`, `user_id`, `wa_phone`, `text` varchar(2000), `handling`, `delivery_status`, `action_id`, `raw_payload`, `error`, `handled_at`, `created_at`.
  - Indexes: `(wa_phone, created_at)`, `(user_id, created_at)`.
- **`assistant_tool_calls`**
  - Columns: `id`, `user_id`, `message_id`, `tool`, `input` jsonb, `output` jsonb (≤4 KB), `ok`, `error`, `latency_ms`, `action_id`, `created_at`.
  - Index: `(user_id, created_at)`.

These are all new tables, so mirroring them in `schema.ts` cannot break existing readers.

---

## (d) Test plan per gate

**Harness:**
- **Unit tests** (vitest): pure, or with `@/lib/db`, fetch and the LLM mocked. They live under `src/lib/assistant/__tests__/` and `src/lib/wa-assistant/__tests__/`.
- **Integration** (`scripts/verify-wa-assistant.ts --gate N`): runs on **sandbox**, after you apply E-306. Uses real builders, prefixed fixtures and cleanup, with the prod-host refusal guard.
- **Invariant tests are named `INV1_…` to `INV9_…`.**

Every gate runs:
```
npm run type-check                          # with NODE_OPTIONS=--max-old-space-size=8192 (it silently OOMs otherwise)
npm run lint
npm test
```
Those baselines are already red: about 116 existing type errors, and 2 storage test files fail. "Green" means no **new** errors, judged by diffing the counts.

- **Gate 0.**
  - Unit: a mixed payload (dealer number + assistant number) goes through `parseInbound`; the guard keeps only the dealer number's events.
  - Unit: statuses carry `phoneNumberId`.
  - Unit: an unset env passes everything through.
- **Gate 1.**
  - Unit:
    - `vocab` freeze snapshot; every §9.3 row resolves; unknown phrases resolve to `question`.
    - HMAC verify (valid, invalid, length mismatch, missing secret).
    - Zod parse (text, interactive `button_reply` / `list_reply`, audio / image / sticker, statuses, a malformed payload).
    - Link-code regex; `planVisitWrites` includes the scheduled row for `next_visit`.
    - Fixed-reply texts.
  - Integration (sandbox):
    - `recordVisit` with `next_visit` → the lead is in `fetchAsmQueueRows({tab:'today'})` on that date.
    - Interest route: a non-owner gets `ForbiddenLeadAccessError`.
    - `claimLead` by an ASM sets `asm_id`, and a forced failure rolls back both writes.
    - Link: issue → verify → active; a re-link revokes the old binding; the 6th wrong code within an hour → locked.
    - Router: an unlinked number, and a linked user with role ≠ asm/ISR, each get exactly the UC-13 reply, no model call, with `handling` logged.
  - Manual (Meta test number, the 4 pilot phones): LINK end to end.
- **Gate 2.**
  - `tabFilter-golden`, committed first: `@/lib/db` is mocked to capture SQL; `fetchQueueRows` / `fetchAsmQueueRows` run for all 10 tabs, rendered via `PgDialect.sqlToQuery`, and snapshotted. The export commit must leave the snapshot byte-identical. That proves "identical rows" without a DB.
  - Integration: for all 10 tabs, rows from `fetchQueueRows` ⊆ the scope predicate, and they equal the tab clause run through `scope.ts`.
  - `INV1`: an out-of-scope lead id and a nonexistent id return an identical `not_found` result.
  - Registry: unknown role → `[]`; an ISR outside the pilot → reads only.
  - `INV5`: the agent input never contains taps, LINK codes or media (router test with a spy on the agent).
  - Lease: two parallel `withUserLease` calls → the second starts after the first finishes (timestamps); an expired lease is reclaimable.
  - Kill switch returns the fixed reply.
  - `INV9`: every inbound gets a row with `handling`; each tool call gets a row.
- **Gate 3.**
  - Integration: `my_queue` = the screen **row for row** on all 10 tabs (same args as the queue routes, capped at 10); `my_numbers` deep-equals `buildSalesDashboard` + `listTargets` with the same args.
  - Unit: every renderer at 24/72/900/1000 boundaries, with emoji, Devanagari, and surrogate pairs never split.
  - `INV8`: redaction on free text.
  - Smoke: 20 EN+Hinglish questions per role. The fixture runs with the model mocked in unit tests, and once against the real model with `scripts/wa-assistant-smoke.ts`.
- **Gate 4.**
  - `INV2`: a typed "yes", "haan", "confirm" or a pasted `ast:c:<id>` as text writes nothing (the row stays `pending`).
  - `INV3`:
    - an expired tap → `expired`, no write;
    - a replayed tap → "Already saved";
    - **race**: two concurrent `executeAction` calls produce exactly one `confirmed` and one rejection, with one touchpoint row;
    - a revoked binding, an inactive user or a stale lead between preview and tap → rejected and logged.
  - UC-02, UC-03, UC-07 end to end against sandbox with Graph mocked.
  - The touchpoint-route extraction keeps its error mapping (unit tests on `planTouchpoint`).
- **Gate 5.**
  - UC-01 commits every part (visit, touchpoint, interest, scheduled row) in one tx; a forced failure injected after the visit insert leaves **zero** new rows (counts before and after).
  - A high-impact Lost reason cannot reach `markLeadLost` without a `step=2` confirm, and a double tap on stage 1 doesn't count as stage 2.
  - UC-05 claim, including the ASM out-of-territory refusal.
- **Gate 6.** An automated attack suite covering every case in prompt §7. Each asserts both **blocked** and a **log row** (`handling` / `status`).
  - The "two same-name dealers" case asserts that a candidate list is returned, never a pick.
  - Prompt injection is tested at the tool boundary (a mass-lost attempt still produces at most one pending action per turn, which only a tap can run) and with the real model in the smoke script.
  - Anything I can't automate will be listed in PROGRESS.md.
- **Gate 7.** RUNBOOK only:
  - env vars per environment;
  - E-306 apply steps;
  - adding pilot users;
  - revoking a number;
  - both kill switches;
  - daily log-review SQL (leaks, unconfirmed writes, stuck `executing`, unhandled inbound, voice-note counts, lockouts).

## Verification

After each gate, `PROGRESS.md` gets the commands and their output:
- `npm test -- src/lib/assistant src/lib/wa-assistant src/lib/whatsapp/__tests__/phone-number-guard.test.ts`
- `node --import tsx --env-file=.env.local scripts/verify-wa-assistant.ts --gate N` (sandbox)
- the type-check and lint deltas against baseline
- for Gates 1 and 3–5: a manual run on the Meta test number with the pilot phones.

I never apply migrations, change `.env*` values, point anything at prod, or message real (non-test) numbers.
