# Buyback email delivery — setup & verification

What the buyback notification dispatcher (`src/lib/buyback/dispatch.ts`) actually
sends over EMAIL, which env vars control it, and how to verify a send worked in
each environment. Read `src/lib/buyback/dispatch.ts` and `src/lib/email/mailer.ts`
first if anything here looks out of date — this file describes what those two
files do, not the other way around.

## How a message actually leaves the building

There is no separate mail worker process. `POST /api/admin/buyback/...` routes
write `buyback_notification_events` rows inside their own transaction and return
immediately (BRD §6's "never inline"). A single in-process ticker —
`startBuybackDispatchTicker()` in `src/instrumentation-node.ts`, started
whenever the Next.js server boots — calls `dispatchPending()` every 30 seconds,
claims up to 50 due rows (`FOR UPDATE SKIP LOCKED`), and sends each one.

This ticker runs on **every** environment that boots the Next.js server: local
`npm run dev`, sandbox pm2, and prod pm2. It does **not** need `npm run worker`
— that starts the BullMQ call-queue worker (a different subsystem, for the AI
dialer), and BullMQ itself is dead code for buyback (see the docblock at the
top of `dispatch.ts` for why: no worker process declares a buyback consumer,
and Vercel crons don't fire on the pm2 boxes anyway).

## The two mail transports (`src/lib/email/mailer.ts`)

`getMailer()` picks a transport by which env vars are set, in this order:

1. **AgentMail** (preferred) — used when BOTH are set:
   - `AGENTMAIL_API_KEY`
   - `AGENTMAIL_INBOX`
   - `AGENTMAIL_BASE_URL` — optional, defaults to `https://api.agentmail.to`.

   AgentMail sends *from* the configured inbox itself (`care-itarang@agentmail.to`
   at the time of writing) — there is no `from` address to set. It's a plain
   authenticated `POST /v0/inboxes/{inbox}/messages/send`, 20s timeout.

2. **SMTP fallback** — used only when AgentMail is not configured. Requires
   ALL FOUR:
   - `SMTP_HOST`
   - `SMTP_PORT`
   - `SMTP_USER`
   - `SMTP_PASS`

   (`secure` is inferred: `port === 465`.) If neither AgentMail nor a complete
   SMTP set is present, `sendMail()` throws — the dispatcher catches that per
   event, marks the row `PENDING` (or `FAILED` after 6 attempts) with the
   error message, and keeps retrying every subsequent tick.

Historical note (see the file's own docblock): the app originally sent over
Hostinger SMTP as `it@itarang.com`; Hostinger blocked that mailbox's outbound
sending, which is why AgentMail exists and is preferred when both are
configured.

## What actually sends an EMAIL today

Every state transition maps to a `{party, channel}` pair via
`NOTIFICATION_FOR` in `src/lib/buyback/transition.ts`. Read that table and it
looks like almost nothing goes out by EMAIL — DEALER-facing transitions are
all `WHATSAPP`, and most everything else is `PORTAL` (the CRM's in-app bell,
`notifyRoles()`). EMAIL only shows up where an API route **overrides** the
default via an explicit `fanOut` array. As of this writing, that's four
places, all VENDOR-facing (a dealer is never emailed — there is no
dealer-facing email path in this codebase today):

| Event / route | Who | When | Attachment | Copy in `dispatch.ts` |
| --- | --- | --- | --- | --- |
| `route_to_vendors` — `POST /api/admin/buyback/requests/:id/routing` | Every routed vendor | MARGIN_SET → VENDOR_ROUTED, one email per vendor quoted | The masked quotation PDF (`p.key`) | `renderMessage()`'s `case "route_to_vendors"` |
| `record_vendor_agreement` (losing vendors) — `POST /api/admin/buyback/threads/:id/record` | Every vendor who quoted but lost | The FIRST vendor agreement on a deal, to every OTHER vendor with a quote | None | `p.kind === "vendor_lost"` branch (checked before `event_type`) |
| `reopen` (withdrawn quotations) — `POST /api/admin/buyback/requests/:id/reopen` | Every vendor with an open (unagreed) thread | A reopen withdraws every live quotation | None | Same `"vendor_lost"` branch, reused — the vendor sees the same "we've placed it elsewhere" copy whether they lost to a competitor or the whole round was withdrawn |
| `approve_invoice` (vendor invoice) — `POST /api/admin/buyback/requests/:id/invoice` | The agreed vendor | Their invoice is approved | The vendor invoice PDF (`pdfKey`) | **Falls through to the generic `default:` case** — `event_type` is `approve_invoice`, and there is no `p.kind === "vendor_invoice"` branch, so the email body is the boilerplate `"{request_no}: approve_invoice."` rather than dedicated copy. Noted here as-is (out of scope for this doc to fix); a real dedicated `case` for it would be a small, separate follow-up. |

Every one of these losing-vendor / withdrawn-quotation payloads deliberately
omits the winning price — see the `vendor_lost` comment in `dispatch.ts`:
"Note what is NOT here: the winning price. A losing vendor must not learn what
they were beaten by."

## Applying the env vars per environment

**LOCAL** — add to `.env.local` (never committed) and restart `npm run dev`:

```
AGENTMAIL_API_KEY=...
AGENTMAIL_INBOX=...
# or, without AgentMail:
SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
```

**SANDBOX** — deploys never overwrite sandbox's `shared/.env` (unlike prod —
see below), so this is a one-time, on-box edit:

```bash
# on 72.61.246.37, as/via the itarang-sandbox user
vi /home/itarang-sandbox/htdocs/sandbox.itarang.com/shared/.env
# add/update AGENTMAIL_API_KEY / AGENTMAIL_INBOX (or the SMTP_* set)

sudo -iu itarang-sandbox pm2 reload sandbox-web --update-env
```

Changing the GitHub Actions env secret does **not** propagate to sandbox —
`shared/.env` there is seeded once and only ever changed by editing it
directly on the box.

**PRODUCTION** — the opposite: prod's `shared/.env` **is** rewritten from the
`PROD_ENV_FILE_B64` GitHub secret on every deploy, so a box-only edit will be
silently reverted the next time anyone deploys. A durable change needs BOTH:

1. Edit the box directly (same shape as sandbox, different path/user):
   ```bash
   vi /home/itarang-crm/htdocs/crm.itarang.com/shared/.env
   sudo -iu itarang-crm pm2 reload itarang-crm-web --update-env
   ```
2. **And** update the `PROD_ENV_FILE_B64` GitHub Actions secret (base64 of the
   full env file) so the next deploy doesn't clobber step 1.

## Verifying delivery

`buyback_notification_events.delivery_status` goes `PENDING` → `SENT` (or
`FAILED` after `MAX_ATTEMPTS = 6` tries, with exponential backoff — 1m, 5m,
15m, 45m, 2h15, 2h15).

1. Trigger a real event (route a lot to a vendor, etc.) — or, to check the
   mailer's plumbing in isolation without touching real deal state, run:

   ```bash
   npx tsx --env-file=.env.local scripts/buyback-email-smoke.ts --to you@example.com
   ```

   (see that script's own header for exactly what it does — it only enqueues
   a row, it never sends anything itself).

2. With the app running (`npm run dev`, or the sandbox/prod pm2 process),
   wait up to ~30s for the next dispatcher tick, then:

   ```sql
   SELECT id, event_type, channel, recipient_ref, delivery_status,
          attempts, sent_at, error
   FROM buyback_notification_events
   ORDER BY created_at DESC
   LIMIT 20;
   ```

3. `delivery_status = 'SENT'` with a `sent_at` timestamp means the configured
   mailer accepted it. `'FAILED'`, or a still-`'PENDING'` row with `attempts >
   0` and a nonempty `error`, means the mailer rejected it — the `error`
   column has the provider's own message (HTTP status + body for AgentMail;
   the SMTP library's error for the fallback), truncated to 500 characters.

4. The server log also prints a one-liner per tick when anything was claimed:
   `[instrumentation:buyback-dispatch] claimed=N sent=N failed=N exhausted=N`,
   and a separate `console.error` if anything hit the retry ceiling
   (`exhausted > 0`) — that line means a dealer or vendor was NOT told
   something, and is worth treating as an incident, not a shrug.
