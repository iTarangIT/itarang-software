# WhatsApp Sales Assistant — Runbook

Operating the CRM AI Assistant Phase 1 (ASM + ISR on WhatsApp).
- Spec: `docs/ai-assistant-whatsapp/CRM_AI_Assistant_Phase1_WhatsApp_BRD.pdf`
- Build log: [PROGRESS.md](PROGRESS.md)
- Design: [PLAN.md](PLAN.md)

**Status on 25 Sep 2026:**
- All work is on the `Aditya` branch, not merged.
- E-306 is on sandbox (database-1) and **not on prod** (database-2). Checked read-only with `scripts/apply-e306.mjs --target prod --verify-only`: 0/5 tables.
- Nothing is configured on either box yet (`WA_ASSIST_*`).

| Section | For |
|---|---|
| [1. What runs where](#1-what-runs-where) | orientation |
| [2. Environment variables](#2-environment-variables) | every environment |
| [3. Apply E-306](#3-apply-e-306) | before the first deploy that turns it on |
| [4. Release (Day 7)](#4-release-day-7) | go-live, in order |
| [5. Kill switches](#5-kill-switches) | incidents |
| [6. Pilot users (writes)](#6-pilot-users-writes) | adding / removing |
| [7. Daily log review](#7-daily-log-review) | every working day of the pilot |
| [8. Numbers: unlink, revoke, lost phone, leaver](#8-numbers-unlink-revoke-lost-phone-leaver) | people changes |
| [9. Troubleshooting](#9-troubleshooting) | symptoms → fixes |
| [10. Rollback](#10-rollback) | undoing a release |
| [11. Verification commands](#11-verification-commands) | after any change |
| [12. Known limits and open decisions](#12-known-limits-and-open-decisions) | before go/no-go |

---

## 1. What runs where

| Piece | Where | Notes |
|---|---|---|
| Webhook | `POST/GET /api/assistant/wa/webhook` | Signature → `phone_number_id` → dedupe insert → **200** → router in `after()` |
| Link page | CRM → sidebar **Link WhatsApp** (`/settings/whatsapp-link`), ASM + ISR only | Shows "not available yet" until `WA_ASSIST_*` is set |
| Router, identity, lease, client | `src/lib/wa-assistant/*` | WhatsApp only |
| Agent, tools, executor | `src/lib/assistant/*` | Channel-agnostic |
| Action sweep | in-process ticker, every 60 s (`instrumentation-node.ts`) | Expires previews; fails actions stuck in `executing` > 5 min |
| Tables | `assistant_wa_bindings`, `assistant_conversations`, `assistant_actions`, `assistant_wa_messages`, `assistant_tool_calls` | E-306; nothing else reads them |
| Model | Google Gemini (`gemini-3.6-flash`, thinking LOW) via LangChain | Key `WA_ASSIST_GEMINI_API_KEY` |

The dealer bot (`/api/whatsapp/webhook`, `META_WA_*`, `whatsapp_messages`) is a separate flow. It shares **nothing** with the Assistant except the Meta app and WABA. Its Gate 0 guard drops events for any other `phone_number_id`, and that guard ships in the same merge.

## 2. Environment variables

| Variable | Required | Sandbox | Production | Effect when missing / wrong |
|---|---|---|---|---|
| `WA_ASSIST_PHONE_NUMBER_ID` | yes | Meta **test** number's id | the real Assistant number's id | Webhook **503**; link page "not available yet" |
| `WA_ASSIST_ACCESS_TOKEN` | yes | System-User token (same value as the dealer bot's today) | same | 503; replies fail (see `outbound_failures`) |
| `WA_ASSIST_APP_SECRET` | yes | Meta App Secret (same app) | same | 503. Also keys the LINK-code HMAC: **changing it invalidates outstanding codes** (not existing links) |
| `WA_ASSIST_VERIFY_TOKEN` | yes | long random string | a *different* long random string | Meta handshake fails |
| `WA_ASSIST_GRAPH_VERSION` | no | `v21.0` | `v21.0` | — |
| `WA_ASSIST_DISPLAY_NUMBER` | no | e.g. `+1 555…` (test) | `+91 …` | Link page says "the iTarang Sales Assistant number" |
| `WA_ASSIST_GEMINI_API_KEY` | for replies | AI Studio key | AI Studio key **with billing** (§12) | Linked reps get "The assistant is being set up…" |
| `ASSISTANT_MODEL` | no | blank | blank | Default `gemini-3.6-flash`. `gemini-2.5-flash` is refused to new API users |
| `ASSISTANT_WRITES_ENABLED_USER_IDS` | no | fixture/pilot ids | the 4 pilot `users.id` (§6) | Empty = nobody can propose writes; reads work for all linked reps |
| `ASSISTANT_DISABLED` | no | `false` | `false` | `true` = kill switch (§5) |
| `ENABLE_WA_ASSIST_SWEEP` | no | unset | unset | `0` disables the 60 s sweep (only for debugging) |
| `NEXT_PUBLIC_APP_URL` | existing | `https://sandbox.itarang.com` | `https://crm.itarang.com` | CRM links in replies |

All of these are read **per message** from `process.env`. A change takes effect after the process reloads with the new env.

**Changing env on the boxes.** These are the team's deploy notes; confirm on the box before relying on them.

**Sandbox** (72.61.246.37, user `itarang-sandbox`, pm2 app `sandbox-web`):
- The app reads `shared/.env`, which deploys **never overwrite**.
- To change it, edit `/home/itarang-sandbox/htdocs/sandbox.itarang.com/shared/.env`, then run `sudo -iu itarang-sandbox pm2 reload sandbox-web --update-env`.
- Changing the GitHub environment secret alone does nothing.

**Production** (user `itarang-crm`, pm2 app `itarang-crm-web`, `/home/itarang-crm/htdocs/crm.itarang.com`):
- `shared/.env` is **rewritten from the `PROD_ENV_FILE_B64` GitHub secret on every deploy**.
- A durable change needs both steps:
  1. Update the secret (base64 of the full file).
  2. Edit the box's `shared/.env` + `pm2 reload itarang-crm-web --update-env` for an immediate effect.
- Doing only step 2 means the next deploy silently reverts it. That is how the kill switch or the pilot list could come back wrong.

`.env.example` documents every variable (names only). Never put a value there.

## 3. Apply E-306

Five new tables, additive and idempotent; no existing table is touched. Apply it **before** `WA_ASSIST_*` is set on that host. With the env set and no tables, the webhook answers 500 on every inbound.

```bash
# read-only check (safe any time)
node --env-file=.env.production scripts/apply-e306.mjs --target prod --verify-only
# apply — only with an explicit go-ahead for production
node --env-file=.env.production scripts/apply-e306.mjs --target prod
```
- `--target` must match the host (database-1 = sandbox, database-2 = prod), or the script aborts.
- It applies the file twice (the second pass must be a no-op).
- It then verifies all 5 tables and 12 index definitions, including the four partial unique indexes' `WHERE` predicates, on a **fresh connection**. DDL through `postgres.js` `unsafe()` escapes a rollback, so a same-session "rolled back" check proves nothing.
- Then tick the prod column of the `E-306_wa_assistant` row in `drizzle/MIGRATION_CHECKLIST.md`.

`schema.ts` mirrors only these new tables, so on a host without E-306 nothing outside the Assistant breaks:
- the sweep logs `assistant_actions missing (apply E-306) — sweep idle`;
- the link page shows "not available yet" (Gate 7 fix `fc3add0c`).

## 4. Release (Day 7)

Do these in order. Each step says what proves it worked.

1. **Merge `Aditya` → `main`.** Pushing `main` deploys **sandbox**. There will be conflicts in `src/lib/db/schema.ts`, `src/components/layout/sidebar.tsx` and `drizzle/MIGRATION_CHECKLIST.md`. Resolve them additively: keep both sides, and don't duplicate the checklist row.
   *Proof:* the sandbox `/settings/whatsapp-link` page loads for an ASM.
2. **Sandbox env + Meta test number.**
   - Set `WA_ASSIST_*` in sandbox `shared/.env` and reload (§2).
   - In Meta, point the **test number's** webhook override at `https://sandbox.itarang.com/api/assistant/wa/webhook` with the sandbox verify token.
   - Keep the app-level default on the dealer route. See Meta's *Webhooks → Override callback URL* for the phone-number-level call. The `messages` field must be subscribed; it already is for the dealer bot.
   *Proof:*
   - `curl "https://sandbox.itarang.com/api/assistant/wa/webhook?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=42"` → `42`
   - a LINK from a pilot phone → "Linked: <name> (ASM|ISR)"
   - `link_ok` in `assistant_wa_messages`
3. **Manual run on the test number** with the 4 pilot phones: UC-01, 02, 03, 05, 07 each confirmed once, one Cancel, one typed "yes".
   *Proof:* `scripts/wa-assistant-daily-review.ts` (on sandbox) shows no incidents.
4. **Gate 0 guard live in production.** Push `main` → `production`. The dealer webhook now drops events whose `phone_number_id` isn't `META_WA_PHONE_NUMBER_ID`. This must be live **before** the Assistant number receives any message.
   *Proof:* the dealer bot still answers a dealer.
5. **Apply E-306 to prod** (§3), with an explicit go-ahead.
   *Proof:* `--verify-only` prints `OK`.
6. **Prod env** (§2: GitHub secret **and** box). Set:
   - `WA_ASSIST_*` for the **real** number;
   - `WA_ASSIST_GEMINI_API_KEY` (billing on, §12);
   - `ASSISTANT_WRITES_ENABLED_USER_IDS` = the 4 pilot ids (§6);
   - `ASSISTANT_DISABLED=false`.
   Reload.
   *Proof:*
   - the boot log has no `WhatsApp Assistant not configured` line;
   - the boot log has `wa-assistant action sweep (60s) started in-process`;
   - the handshake `curl` on `crm.itarang.com` echoes the challenge.
7. **Meta override on the real number** → `https://crm.itarang.com/api/assistant/wa/webhook`, prod verify token.
8. **Link the pilot phones.** Each rep opens **Link WhatsApp** and sends `LINK <code>` from their own phone. Reads are on for every linked ASM/ISR from here; writes only for the pilot list.
   *Proof:* `link_ok` rows, one per pilot rep.
9. **Brief the pilot in one call:**
   - it proposes, you tap **Confirm**;
   - typing "yes" never saves;
   - previews expire in 10 min;
   - text only (no voice notes);
   - convert/transfer stay on the CRM.
10. **Start the daily review** (§7) the same evening.

Go/no-go (BRD §10.1), end of the following week:
- **zero** permission leaks and **zero** unconfirmed writes (§7's MUST-BE-EMPTY blocks, every day);
- a meaningful share of pilot calls and visits logged through WhatsApp (`adoption_share`).

## 5. Kill switches

From lightest to heaviest. Each needs the env change + reload (§2). On prod, change the secret too, or the next deploy undoes it.

| Switch | Set | Effect | Pending previews |
|---|---|---|---|
| **Writes off** | `ASSISTANT_WRITES_ENABLED_USER_IDS=` (empty), or remove one id | Write tools disappear; reads keep working | A tap on an old preview is refused `rejected: writes_disabled` (re-checked at the tap) |
| **Assistant off** | `ASSISTANT_DISABLED=true` | Every linked user gets "The iTarang Sales Assistant is paused right now…"; no model, no data. LINK still works | Taps are refused too (the kill switch sits before taps in the router); nothing runs |
| **Channel off** | Remove the number-level override in Meta, **or** unset `WA_ASSIST_APP_SECRET` | Meta stops calling us / the webhook answers 503. Reps get no reply at all | Nothing can run |

The model provider going down needs no switch. Turns fail with "Something went wrong, nothing was changed", and taps (no model involved) keep working.

## 6. Pilot users (writes)

```sql
-- the ids to put in ASSISTANT_WRITES_ENABLED_USER_IDS (comma-separated, no spaces needed)
SELECT id, name, email, role, is_active FROM users
 WHERE email IN ('<asm1>@…', '<asm2>@…', '<isr1>@…', '<isr2>@…');
```
- Only `asm` and `inside_sales_rep` users can use the Assistant at all. Any other role gets the "for iTarang staff" reply, whatever the list says.
- **Adding** someone takes effect on their next message after the reload.
- **Removing** someone blocks their next Confirm even on a preview already on their phone.

## 7. Daily log review

```bash
node --import tsx --env-file=.env.production scripts/wa-assistant-daily-review.ts            # last 24 hours
node --import tsx --env-file=.env.production scripts/wa-assistant-daily-review.ts --since '7 days'
```
- The queries live in [review.sql](review.sql), one named block each; paste any block into a SQL editor.
- The runner is read-only (every block in a `READ ONLY` transaction).
- It exits **1** if a go/no-go block returns rows.
- All 14 are proven by attack check A13: the attack traces show up, and one planted incident per MUST-BE-EMPTY block is caught.

| Block | Must be empty? | If it has rows |
|---|---|---|
| `leak_write_on_foreign_lead` | **yes** | Assistant off (§5), then investigate the action's `before`/`after` and its tool calls |
| `leak_sensitive_outbound` | **yes** | Assistant off; find the tool result that carried it (`assistant_tool_calls` by `message_id`) |
| `leak_served_ineligible_user` | **yes** | Check whether the role or `is_active` changed *after* the message (users audit) before escalating |
| `unconfirmed_write` | **yes** | Assistant off; a write without a Confirm tap should be impossible |
| `stuck_executing` | **yes** | The sweep isn't running: check the boot log and `ENABLE_WA_ASSIST_SWEEP` |
| `unhandled_inbound` | — | A few around a deploy (a restart drops `after()` work) are expected. Reply to the rep by hand; a steady trickle is a bug |
| `errors` | — | `rejected: stale / not_owner / not_claimable / writes_disabled` = the guards working. Anything else: read the sample |
| `media_by_type` | — | Voice-note demand for Phase 2 |
| `link_attempts` | — | Many numbers failing = someone guessing codes (each number locks for an hour after 5) |
| `revoked_number_attempts` | — | A lost or handed-over phone: call the rep named there (§8) |
| `usage_per_user` | — | The daily usage report |
| `adoption_share` | — | The go/no-go adoption number |
| `outbound_failures` | — | A burst = a bad token, or a reply outside Meta's 24-hour window |
| `tool_latency` | — | p95 creeping towards 10 s → turns start timing out (45 s budget, 4 model calls) |

## 8. Numbers: unlink, revoke, lost phone, leaver

| Situation | Do | Effect |
|---|---|---|
| Rep changes phone | Rep: **Link WhatsApp → Unlink**, then link the new phone (or just link the new phone; the old binding is revoked `relinked`) | Old phone gets "for iTarang staff" from its next message |
| Phone handed to another rep | The new holder links with *their* code | Old binding `number_relinked`; the first rep's open previews can't be confirmed from it (A9.3) |
| Lost / stolen phone, rep unreachable | Admin revokes (SQL below) | Immediate: identity is re-checked on every message |
| Leaver, or role change | Deactivate or change role in the CRM as usual | The binding revokes itself (`user_inactive` / `role_changed`) on the next message from that phone; nothing runs before that |

```sql
-- admin revoke: the active binding and any outstanding LINK code
UPDATE assistant_wa_bindings
   SET status = 'revoked', revoked_at = now(), revoked_reason = 'admin_revoked', updated_at = now()
 WHERE user_id = '<users.id>' AND status IN ('active', 'pending');
```
Messages from a revoked number are logged `handling = unlinked` **without** a `user_id`. The phone may be someone else's now. `revoked_number_attempts` names the last rep who held it.

## 9. Troubleshooting

| Symptom | Likely cause | Check / fix |
|---|---|---|
| Webhook answers **503** | A required `WA_ASSIST_*` is missing or malformed | Boot log line `WhatsApp Assistant not configured …` names the variable (never its value) |
| Webhook answers **401** | Wrong `WA_ASSIST_APP_SECRET`, or not Meta | Structured log `[wa-assist/webhook] bad signature`. Forged requests are logged there only, never stored |
| Meta handshake fails | Verify token mismatch | The `curl` in §4 step 2 must echo the challenge |
| Messages arrive (rows exist) but no reply | Token expired / wrong number id / outside 24 h | `outbound_failures` |
| No rows at all for a rep's message | Override not on this number, or the event is for another `phone_number_id` | Log `ignored event for another phone_number_id` |
| "This number is for iTarang staff…" | Not linked, revoked, inactive, or not ASM/ISR | `assistant_wa_bindings` for the user; `resolveSender` revokes on inactive / role change |
| "The assistant is being set up…" | `WA_ASSIST_GEMINI_API_KEY` unset | Set it (§2) |
| "Something went wrong, nothing was changed" | Model error (often a **429 quota**) or a bug | `errors` block; logs `[wa-assist] turn failed` with the provider message id |
| "I'm still working on your last message…" | The rep's previous turn still holds the lease (up to 60 s wait) | Normal for quick double messages; frequent = slow model (`tool_latency`) |
| "Too many wrong codes…" | 5 wrong LINK codes in an hour from that number | Wait the hour; the code still works from the rep's own phone |
| "This lead changed since the preview…" | Someone (or the AI dialer / NeoDove) touched the lead between preview and tap | By design: send the message again |
| "This action expired…" | Tapped after 10 minutes | By design |
| Next visit not in Today's Schedule | Lead's field ASM (`asm_id`) isn't the rep; the preview warns | Transfer / claim on the CRM sets it |
| A call can't be logged, the Assistant keeps asking | Disposition outside the frozen §9.3 map (37% of real calls, §12) | Log it on the screen |
| Sweep log `assistant_actions missing` | E-306 not applied on this DB | §3 |

## 10. Rollback

- **Fast:** kill switch (§5). No deploy needed.
- **Code:** revert the merge on `main` / `production` and redeploy. The sidebar item and the routes disappear; the dealer bot's Gate 0 guard goes with it. Only do that after the Assistant number's override is removed in Meta, so no Assistant event can reach the dealer route unfiltered.
- **Data:** E-306 is additive and is **not** rolled back. The tables are inert without the code; dropping them is a separate, deliberate decision (it deletes the audit trail).
- CRM writes the Assistant made are ordinary touchpoints, visits and status history, written by the same functions the screens use, and audited the same way (E-304 triggers record the rep as the actor). Correct them on the CRM like any other entry. `assistant_actions.before/after` shows what changed.

## 11. Verification commands

```bash
npx vitest run src/lib/assistant src/lib/wa-assistant                                          # unit, no DB
node --import tsx --env-file=.env.local scripts/verify-wa-assistant.ts --gate 5                 # sandbox integration (47)
node --import tsx --env-file=.env.local scripts/verify-wa-assistant-attacks.ts                  # sandbox attack suite (20)
node --import tsx --env-file=.env.local scripts/wa-assistant-smoke.ts                           # real model, 40 questions (needs Gemini quota)
node --import tsx --env-file=.env.local scripts/wa-assistant-mapping-check.ts [--model]         # 30 real call notes (read-only)
```
- The two `verify-*` scripts **write fixtures** (prefixed, cleaned up) and refuse to run against the prod host.
- The smoke and mapping scripts send real text to Google.

## 12. Known limits and open decisions

| # | Item | Status |
|---|---|---|
| 1 | **Gemini key is on the free tier** (20 req/min + a daily cap): roughly 7–10 turns a minute for *everyone*, and the 40-question smoke run and the model half of the mapping check could not finish | Enable billing before §4 step 6 |
| 2 | **§9.3 map covers 62.7% of real calls.** 358/959 real dispositions are outside it (No requirement in current 190, Short Hang up 81, REJECTED BY US 67, …), so those calls can't be logged over WhatsApp | Product decision on rows for the 8 missing dispositions (PROGRESS, Gate 6) |
| 3 | Hinglish aliases matched 0 of 30 real notes; reps write English shorthand ("cb", "not rq") | Decide on shorthand hints |
| 4 | `mark_lost` offers 10 reasons, not 11 (`onboarding_dropout` is admin-only on the screen) | Confirm |
| 5 | Forged / foreign-number webhooks are visible in the structured log only, not in the tables | Keep, or add a counter table |
| 6 | `after()` work is lost if the process restarts mid-turn | `unhandled_inbound` finds them; move to a queue only if they're seen |
| 7 | Pre-existing, not fixed: the mark-lost API accepts `onboarding_dropout` from any role; queue pagination ties on Unassigned/Territory/Unclaimed; the visit form defaults to the UTC date | Separate tickets |
| 8 | Manual run on the Meta test number not done | §4 step 3 |
