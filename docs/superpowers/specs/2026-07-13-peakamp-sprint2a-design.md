# peakAmp Sprint 2A — the vendor leg & fulfilment

**Date:** 2026-07-13 · **Status:** implemented · **Scope:** M09, M10, M11 + a minimal M05 pass-through

Sprint 1 took a deal from `DRAFT` to `MARGIN_SET`. Sprint 2A carries it to `PICKED_UP`:

```
MARGIN_SET → VENDOR_ROUTED → VENDOR_NEGOTIATING → VENDOR_AGREED
           → PO_EXCHANGED → PICKUP_SCHEDULED → PICKED_UP
```

Money (M12 invoices, M13 settlement, M14 ledger) is **Sprint 2B**. The BRD's sprint
table groups all six modules into one sprint; we split it, because the sell side and
the money side are independent subsystems and one spec covering both would go thin.
2A moves batteries; 2B moves rupees.

## Decisions taken

| Question | Decision | Why |
|---|---|---|
| Sprint 2 scope | Two specs, back to back | A working checkpoint halfway, matching the BRD's own "one vertical slice before widening" rule |
| Pickup states, when M05 is Sprint 3 | Minimal pass-through | The deal must legitimately *enter* `PICKUP_SCHEDULED`/`PICKED_UP` to reach the invoice. Skipping them would mean rewriting the state machine and its golden fixtures later |
| Vendors, when M18 is Sprint 4 | Minimal admin CRUD | Routing filters on `business_entity_roles.status = 'ACTIVE'`, so Sprint 4 tightens what ACTIVE *means* without changing this code |
| Quotation masking | City + state only | Enough for a vendor to price transport; not enough to identify the dealer |
| GST/HSN (Chirag's open item) | Model the columns, don't rule | Documents render tax-exclusive with a visible "tax treatment pending" note. His ruling becomes a data change, not a migration |
| Notification dispatch | In-process ticker | BullMQ is dead code here and Vercel crons don't fire on pm2 — see below |

## Two corrections to earlier assumptions

**SES was never needed.** Sprint 0 listed "SES production access, multi-day approval,
critical path". Wrong: this repo already sends email with PDF attachments via AgentMail
(`src/lib/email/mailer.ts`). The BRD's "needs a transactional email provider — SES
recommended" is stale.

**PDF generation already existed** — Puppeteer HTML→PDF, live in both sandbox and
production, copy-pasted across four call sites. Sprint 2A extracts
`src/lib/pdf/render-html.ts` and uses it for buyback only; the other four are left
alone.

What genuinely did not exist: **any consumer of `buyback_notification_events`**. Sprint 1
recorded every event durably and nothing read them. That is the real new machinery here.

## Invariants made structural

- **One agreed vendor per deal.** A partial unique index (`vendor_threads (deal_id)
  WHERE status='AGREED'`). Two admins racing to agree with different vendors: one
  commits, the other's transaction fails at the database. A deal cannot end up owing its
  batteries to two buyers.
- **No lump-sum vendor quote.** `vendor_threads` has no amount column; amounts live only
  on `vendor_thread_lines`. (The design prototype accepts per-line amounts and *averages
  them into one number* — that bug is unportable here.)
- **Vendor payloads exclude dealer identity.** `toVendorQuotation()` builds a fresh object
  field by field; the PDF template is handed only that type. The M09 AC ("PDF contains no
  dealer name/phone/GST") is not a promise the template keeps by remembering — it is one
  it *cannot break*. Release-blocking contract test.
- **Below-floor agreement is refused (422), not warned about.** The prototype shows a red
  banner and lets you proceed. The only way forward is `reopen`, which is what BRD §2's
  "below floor → DEALER_REOPENED" means.
- **POs impossible before `VENDOR_AGREED`** — no `exchange_pos` edge exists from any
  earlier state.

## The one deliberate relaxation

`deal_line_locks` was strictly immutable in Sprint 1. BRD §3 puts `vendor_price` on the
lock, but that value does not exist until a vendor agrees — so strict immutability and
the BRD are in direct conflict. Resolution: **fill-once**. A `BEFORE UPDATE` trigger
permits exactly one write, setting `vendor_price` from `NULL`. Everything else —
`dealer_price`, `margin_value`, `margin_mode`, `vendor_ask` — is frozen, and a second
`vendor_price` write is refused. Locks still cannot drift, and every report reads the
whole economics of a SKU from one row.

## The invariant that had to be restated

Sprint 1's rule was "**exactly one** notification event per state change", and its test
counted `events == transitions`. That was right while every transition had one recipient.
It is not right now: routing is one state change but N quotation emails (each needing its
own `message_id` logged, per U6), and an agreement is one state change but a courteous
close to every losing vendor.

The rule the code now enforces — and the one that protects what the AC actually cares
about — is:

> every transition emits **at least one** event, one per recipient, each with its own
> unique idempotency key.

Zero events is still a silent transition (a bug). A duplicate message is still impossible
(the unique key refuses it on retry). What is now allowed is a fan-out, which is what
actually happens in the world. `applyTransition` gains an optional `fanOut`; when omitted,
Sprint 1's behaviour is unchanged.

## Why the dispatcher is a ticker, not BullMQ

BRD §6 says "notifications via BullMQ, never inline". BullMQ is **dead code in this repo**:
production declares no worker process at all, the sandbox worker is deliberately dormant
(`autorestart: false`, no `ENABLE_CALL_WORKER` — it logs "disabled" and exits in under a
second), and `callQueue.add()` is never called anywhere. The 16 crons in `vercel.json` do
not fire on the pm2 VPS either.

An in-process ticker in `src/instrumentation-node.ts` is the only mechanism that
demonstrably runs in **both** sandbox and production — it is how the dialer and the Zoho
sync actually work today.

"Never inline" is still honoured, and that is the part that matters: a route **commits**
the event inside its transaction and returns. The send happens on the ticker, so a slow
mail provider cannot make an admin's click hang, and a bounced email cannot roll back a
state change that really happened. `dispatchPending()` is the unit of work — moving to a
real queue later changes the caller, not the logic.

Delivery is **at-least-once, and honestly so**: rows are leased (`FOR UPDATE SKIP LOCKED`,
attempts incremented, retry pushed out), then sent, then marked. A process that dies
mid-send retries and may duplicate. Exactly-once is not achievable against an external mail
API, so we do not pretend.

## A bug this surfaced in Sprint 1

`exchange_pos` notifies the dealer on WhatsApp — but nothing set a recipient, and Sprint 1
wrote all its events before the `recipient_ref` column existed. Switching the dispatcher on
would have failed **every** dealer WhatsApp event with "no recipient_ref". Fixed in one
place: `applyTransition` now resolves the dealer's phone/email at emit time and **stores**
it, so the audit trail records where a message actually went, not where it would go if sent
today.

## Verification

- **1106 tests pass** (whole repo). The state machine is walked over its full
  21 × 20 × 2 cross-product, so no transition can be widened without a test failing.
- `E-186` applies on top of `E-185` against a real Postgres engine, is idempotent, and
  every invariant it claims is enforced by the database (checked by refusing the
  violation, not by asserting the happy path).
- The whole leg drives `MARGIN_SET → PICKED_UP`: 3 vendors routed (1 state change, 4
  messages), a below-floor bid refused, first-agreed-wins with 2 losers auto-closed, the
  fill-once trigger refusing a second `vendor_price`, POs exchanged, collection completed —
  audit chain unbroken, no duplicate idempotency keys, no silent transitions, and every
  email/WhatsApp event carrying a recipient the dispatcher can actually send to.

## Not done

- **`E-185` and `E-186` are unapplied in every environment.** Nothing here has run against
  a real database. Someone must apply both via pgAdmin (E-185 first) and seed the catalog.
- **The end-to-end click-through has not happened** — no Postgres on the dev box, so this
  is verified by tests and against PGlite (WASM Postgres), not by a human using the app.
- Vendor quote expiry (BRD §6, 72h) is not enforced.
- BWM 2022 pickup fields (e-way, weighbridge, variance, dealer ack) are columns only —
  Sprint 3's M05.
