# Buyback online payments — RazorpayX payouts & Razorpay payment links

What the buyback money surface (`src/components/buyback/MoneyBoard.tsx` and the
routes under `src/app/api/admin/buyback/requests/[id]/settlements/`) uses to pay a
dealer and collect from a vendor **online**, which env vars switch each half on,
and how to register the webhooks. Read the provider clients
(`src/lib/razorpayx.ts`, `src/lib/razorpay.ts`) and the domain core
(`src/lib/buyback/gateway.ts`) first if anything here looks out of date — this
file describes what those do, not the other way around.

The whole surface is **dark until configured**: with none of the env vars below
set, no button appears, every route 409s, both webhooks 200-and-ignore, and the
reconciler ticker no-ops. Nothing here changes until you deliberately turn it on.

## Two dashboards, two key pairs

There is no single "Razorpay" credential. The two halves of the money surface use
two different products, each with its own keys, from two different Razorpay
dashboards:

1. **RazorpayX — dealer payouts (the OUT leg).** Money leaving iTarang's current
   account to the dealer, as a composite payout (`src/lib/razorpayx.ts` →
   `createCompositePayout`). RazorpayX is a **separate product** from the Payment
   Gateway — the standard `razorpay` npm SDK has no RazorpayX support, which is
   why `razorpayx.ts` is a raw `fetch` client. Its keys come from the **RazorpayX
   dashboard** (x.razorpay.com), NOT the PG dashboard, and it needs the current
   account's **account number** as well as the key pair.

   - Test mode: create a RazorpayX **test account** — no KYC or business
     verification is needed to get test keys and a test account number, and test
     payouts settle synchronously to `processed` so the full flow (including the
     minted settlement) can be exercised end to end.

2. **Payment Gateway — vendor collection (the IN leg).** Money coming IN from the
   vendor, collected with a **Razorpay Payment Link**
   (`src/lib/razorpay.ts` → `createBuybackPaymentLink`). Its keys are the **core
   PG keys** (`RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`) from the **PG dashboard**
   (dashboard.razorpay.com) — the same pair the rest of the app already uses for
   NBFC payments.

   - Test mode: the PG test keys are **already present** in the sandbox/prod
     envs (other features use them). Buyback links are still off until you set the
     explicit opt-in flag below — having PG keys is necessary but **not
     sufficient**.

The two key pairs are unrelated: RazorpayX keys will not create a payment link,
and PG keys will not make a payout. Set the pair for each half you want.

## Env vars

### RazorpayX payouts — all three required

`payoutsConfigured()` (`src/lib/razorpayx.ts`) is true **only when all three** are
non-empty. Any one missing ⇒ payouts stay dark.

| Var | What | Where from |
| --- | --- | --- |
| `RAZORPAYX_KEY_ID` | RazorpayX API key id | RazorpayX dashboard → Settings → API keys |
| `RAZORPAYX_KEY_SECRET` | RazorpayX API key secret (never logged) | same — shown once at generation |
| `RAZORPAYX_ACCOUNT_NUMBER` | the RazorpayX current-account number money is paid **from** | RazorpayX dashboard → Account Details |
| `RAZORPAYX_WEBHOOK_SECRET` | HMAC secret for the payout webhook | you choose it when registering the webhook (below) |

`RAZORPAYX_WEBHOOK_SECRET` is not part of `payoutsConfigured()` — a payout can be
initiated without it, but the `payout.*` webhook cannot verify a signature and
will 200-ignore every event, so terminal payout state then arrives only via the
on-demand **Refresh** button and the reconciler ticker. Set it in any environment
where payouts are live.

### Razorpay payment links — explicit opt-in

`buybackLinksConfigured()` (`src/lib/razorpay.ts`) is true only when
**`RAZORPAY_BUYBACK_LINKS_ENABLED === "1"` AND both PG keys are set**.

| Var | What | Notes |
| --- | --- | --- |
| `RAZORPAY_BUYBACK_LINKS_ENABLED` | `1` turns buyback payment links on | The explicit opt-in. PG keys alone do **not** enable links — this flag must be `1`. |
| `RAZORPAY_KEY_ID` | PG key id | Usually already set for NBFC payments. |
| `RAZORPAY_KEY_SECRET` | PG key secret | Usually already set for NBFC payments. |
| `RAZORPAY_BUYBACK_LINK_WEBHOOK_SECRET` | HMAC secret for the payment-link webhook | **Optional.** Falls back to `RAZORPAY_WEBHOOK_SECRET` when unset, so a separate secret is only needed if you want the buyback-link webhook signed with a different key than the app's other Razorpay webhooks. |

The dedicated flag exists so that turning on buyback links is a deliberate act,
never a side effect of the PG keys being present for some other feature.

## Registering the webhooks

Terminal state also arrives by signed webhook (the poller/Refresh are the backup,
not the primary path). Register one webhook in each dashboard:

| Dashboard | Events | URL (sandbox) | Secret |
| --- | --- | --- | --- |
| **RazorpayX** → Settings → Webhooks | `payout.processed`, `payout.reversed`, `payout.failed` (the `payout.*` family) | `https://sandbox.itarang.com/api/payments/razorpay/payout-webhook` | `RAZORPAYX_WEBHOOK_SECRET` |
| **Payment Gateway** → Settings → Webhooks | `payment_link.paid`, `payment_link.cancelled`, `payment_link.expired` (the `payment_link.*` family) | `https://sandbox.itarang.com/api/payments/razorpay/buyback-link-webhook` | `RAZORPAY_BUYBACK_LINK_WEBHOOK_SECRET` (or `RAZORPAY_WEBHOOK_SECRET` if you left the dedicated one unset) |

For production, swap the host for `https://crm.itarang.com`.

Both endpoints **200-and-ignore when their secret env is missing** (a debug line
is logged once, no error), so registering a webhook before the secret is set is
harmless — it just does nothing until the secret lands. Both also scope on an
`itarang_purpose` note (`buyback_dealer_payout` / `buyback_vendor_receipt`) and
200-ignore any event that isn't a buyback one, so sharing the PG webhook secret
with the app's existing Razorpay webhooks is safe.

## Applying the env vars per environment

Identical to the email setup — see `docs/peakAmp/EMAIL_SETUP.md` for the same
sandbox-vs-prod distinction, restated here for the RazorpayX/Razorpay vars.

**LOCAL** — add to `.env.local` (never committed) and restart `npm run dev`:

```
RAZORPAYX_KEY_ID=...
RAZORPAYX_KEY_SECRET=...
RAZORPAYX_ACCOUNT_NUMBER=...
RAZORPAYX_WEBHOOK_SECRET=...
RAZORPAY_BUYBACK_LINKS_ENABLED=1
RAZORPAY_BUYBACK_LINK_WEBHOOK_SECRET=...   # optional; falls back to RAZORPAY_WEBHOOK_SECRET
# RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are usually already present
```

**SANDBOX** — deploys never overwrite sandbox's `shared/.env`, so this is a
one-time, on-box edit:

```bash
# on 72.61.246.37, as/via the itarang-sandbox user
vi /home/itarang-sandbox/htdocs/sandbox.itarang.com/shared/.env
# add the RAZORPAYX_* vars and RAZORPAY_BUYBACK_LINKS_ENABLED=1

sudo -iu itarang-sandbox pm2 reload sandbox-web --update-env
```

Changing the GitHub Actions env secret does **not** propagate to sandbox —
`shared/.env` there is seeded once and only ever changed by editing it directly
on the box.

**PRODUCTION** — the opposite: prod's `shared/.env` **is** rewritten from the
`PROD_ENV_FILE_B64` GitHub secret on every deploy, so a box-only edit is silently
reverted the next time anyone deploys. A durable change needs BOTH:

1. Edit the box directly:
   ```bash
   vi /home/itarang-crm/htdocs/crm.itarang.com/shared/.env
   sudo -iu itarang-crm pm2 reload itarang-crm-web --update-env
   ```
2. **And** update the `PROD_ENV_FILE_B64` GitHub Actions secret (base64 of the
   full env file) so the next deploy doesn't clobber step 1.

### Migration prerequisite

The online-money tables are created by **`E-193_buyback_gateway_payments.sql`**,
which depends on the buyback schema from **E-185..E-188**. Apply them via the
pgAdmin Query Tool (the team's migration path — not the Supabase SQL editor), and
tick `drizzle/MIGRATION_CHECKLIST.md` per environment. **Production currently has
NO buyback tables at all** — E-185..E-188 and E-193 must all be applied there
before any buyback route (online or manual) will work; until then the routes fail
with "relation does not exist".

## Feature-flag behavior

| Env state | MoneyBoard | Routes | Webhooks | Ticker |
| --- | --- | --- | --- | --- |
| RazorpayX unset | no "Pay via RazorpayX" button (`gateway.payouts_enabled` is false in the invoice GET) | `POST .../settlements/payout` → 409, `.../gateway/:txnId/refresh` on a payout → 409 | `payout-webhook` 200-ignores | no payout rows to sweep |
| Links flag off | no "Generate payment link" button (`gateway.links_enabled` false) | `POST .../settlements/payment-link` and `.../cancel` → 409 | `buyback-link-webhook` 200-ignores | no link rows to sweep |
| Both off | only the manual "Record manually" path shows | only the manual settlements route works | both webhooks 200-ignore | ticker returns immediately (`payoutsConfigured() || buybackLinksConfigured()` gate) |

The manual **Record manually** path is never gated on these flags — settling out
of band with proof always works, and is the fallback whenever online is off (or
an online attempt fails). Fixing a dealer's bank details
(`PATCH .../bank-details`) is likewise never gated: it makes no provider call and
must be possible whether or not payouts are switched on.

## Go-live checklist

Before flipping this on in production:

- [ ] **Migrations applied** — E-185..E-188 and E-193 run on prod via pgAdmin,
      checklist ticked. (Prod has no buyback tables until this is done.)
- [ ] **RazorpayX live keys** — `RAZORPAYX_KEY_ID` / `_KEY_SECRET` /
      `_ACCOUNT_NUMBER` from the **live** (KYC-approved) RazorpayX account, in the
      prod box **and** `PROD_ENV_FILE_B64`.
- [ ] **PG live keys + flag** — `RAZORPAY_BUYBACK_LINKS_ENABLED=1` with live
      `RAZORPAY_KEY_ID` / `_KEY_SECRET`, same two places.
- [ ] **Live webhook URLs registered** — `payout.*` → `.../payout-webhook` and
      `payment_link.*` → `.../buyback-link-webhook`, both on `crm.itarang.com`,
      each with its secret, and the matching `*_WEBHOOK_SECRET` env set so the
      endpoint verifies rather than 200-ignores.
- [ ] **RazorpayX account funded** — a payout against an unfunded current account
      queues (`queue_if_low_balance: true`) rather than failing, but it will not
      settle until there is balance. Fund it before the first real payout.
- [ ] **First payout verified small** — do one real, small-amount dealer payout
      end to end, confirm it reaches `processed`, the settlement row is minted
      (method `Razorpay`/`API` in the ledger), and the ledger still reconciles.
- [ ] **REVERSED monitoring** — a bank reversal after a recorded payout surfaces
      as a red "Reversed by bank — needs manual review" chip on MoneyBoard and a
      portal alert; make sure someone watches for it. A reversal means money that
      the ledger counts as paid did not actually stay paid.
