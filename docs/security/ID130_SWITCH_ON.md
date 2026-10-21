# ID 130: switching the security protections on

The code for this is on `Aditya` ("ID 130" commit). Everything below is a
**server step** for whoever owns the box. Sandbox first, then prod.

**Update 16 Oct.** The 15 Oct check still lists one gap: NBFC systems with
their own code can send unsigned agreement / e-NACH / V-KYC results until
`WEBHOOK_AUTH_STRICT=1` is on. That is by design (`allowUnsigned` on the NBFC
rails); step 3 below closes it. The 16 Oct commit also made the last six
hand-written secret compares constant-time (internal security-events, the
NBFC test-only gates, the Meta WhatsApp verify token), removed the
`"test-bypass"` default secret from three NBFC test gates, and made the
legacy `/api/bolna/webhook` refuse under strict mode in every environment and
ring the admin bell when `BOLNA_WEBHOOK_SECRET` is missing. A contract test
(`src/lib/security/__tests__/secret-compare.contract.test.ts`) keeps it that way.
If an NBFC Playwright run used the old default, set
`NBFC_TEST_BYPASS_SECRET=test-bypass` in that server's env.

What the code now does:

- **Every scheduled-job route** (`/api/cron/**`, `/api/scraper/cron`, the two
  NBFC `/cron` routes) needs `Authorization: Bearer $CRON_SECRET`, in every
  environment. There is no "open outside production" any more. If
  `CRON_SECRET` is unset the route refuses, and every admin gets one bell
  notification an hour per route ("Webhook or scheduled job missing its
  secret").
- **Webhooks** with no secret configured are still accepted (logged
  UNVERIFIED) until `WEBHOOK_AUTH_STRICT=1`. They now ring the admin bell once
  an hour per route as well. Under strict mode they answer **503** ("Webhook
  not configured"), and a wrong proof still answers 401.
- The WhatsApp webhook's temporary debug file-logger (`WA_WEBHOOK_DEBUG_LOG`)
  is gone. Remove that env line if it is set.

Prod env changes need **both** the box (`shared/.env`) **and** the
`PROD_ENV_FILE_B64` GitHub secret, because prod's env is rewritten on every
deploy. Sandbox only needs the box (`shared/.env`, which is seeded once).
Reload after each change:

```bash
sudo -iu itarang-sandbox pm2 reload sandbox-web --update-env     # sandbox
sudo -iu itarang-crm     pm2 reload itarang-crm-web --update-env  # prod
```

## 0. Before deploying this code: CRON_SECRET

Every cron route now fails closed, so check that `CRON_SECRET` is set on
both boxes and that the crontab sends it:

```bash
grep -c '^CRON_SECRET=.' shared/.env          # must print 1
crontab -l | grep -c 'Bearer \$CRON_SECRET'   # the curl lines use it
```

The in-process tickers (`instrumentation-node.ts`) call the job functions
directly and are not affected.

## 1. Mon 12 Oct: set the missing webhook secrets

| Env var | Where the same value goes on the provider side |
|---|---|
| `BOLNA_WEBHOOK_SECRET` | Bolna agent → webhook → custom header `Authorization: Bearer <value>` |
| `BOLNA_TOOL_SECRET` | Bolna agent → each tool (price lookup) → header `Authorization: Bearer <value>` |
| `DIGIO_WEBHOOK_SECRET` | Digio Enterprise Dashboard → Profile → Webhook → secret key |

Generate each with `openssl rand -hex 32`. After the reload, place one test
call or e-sign. Check the log shows no `[webhook-auth] UNVERIFIED` line for
that route, and that the call/agreement status updates in the CRM:

```bash
pm2 logs <app> --lines 2000 | grep -E 'webhook-auth\] (UNVERIFIED|REFUSED)'
```

**WhatsApp:** `WHATSAPP_WEBHOOK_INSECURE` is already ignored in production.
Delete the line from both env files anyway.

**Leegality:** check whether any NBFC uses it. If none does, nothing to do;
strict mode will refuse any Leegality call that arrives.

```sql
SELECT tenant_id, esign_provider FROM nbfc_service_config WHERE esign_provider = 'leegality';
```

If one does, that NBFC saves its Private Salt in its e-sign settings
(Leegality dashboard → API Settings) before Wednesday.

## 2. Mon 12 – Tue 13 Oct: read the "would refuse" log

`API_AUTH_GATE` is in `report` mode (the default), so the gate only logs:

```bash
pm2 logs <app> --lines 20000 | grep '\[api-gate\] would refuse' | sort | uniq -c | sort -rn
```

For each path:

- A **logged-out page or a bot** → fine, it will be refused.
- A **genuine outside caller** (a provider webhook, a public form) → add it to
  `PUBLIC_API_RULES` in `src/lib/security/publicApi.ts`, with the reason, and
  deploy before Wednesday.

Already on the allowed list (18 Oct, no action needed — do not count these as
gaps in the log):

- `/api/files/open` — the "open file" link in downloads and e-mails (ID 166).
  The route checks the login itself and sends a logged-out click to `/login`,
  so it is let through the gate; with the gate refusing it, the person would
  see `Unauthorized` instead of the login page.
- Signed file links (`?exp=&sig=`) to `/api/files/documents|dealer-documents|call-recordings/…`
  **and** `/api/nbfc-uploads/…` (signed NBFC-file links). The gate only lets a
  link that carries a signature reach the route; the route checks the
  signature, its expiry and the login (since 17 Oct every open needs a login,
  so a logged-out signed link still gets `401` from the route).

## 3. Wed 14 Oct: enforce

Add to the env (box, plus the GitHub secret for prod), then reload:

```
API_AUTH_GATE=enforce
WEBHOOK_AUTH_STRICT=1
```

Watch for an hour:

```bash
pm2 logs <app> | grep -E 'api-gate|webhook-auth|cron-auth'
```

Business check:

1. Logged out, `curl -i https://crm.itarang.com/api/leads` → `401 Unauthorized`.
   Logged out, `curl -i "https://crm.itarang.com/api/files/open?u=/api/files/documents/x.pdf"`
   → `302` to `/login` (not 401).
2. A forged Digio "signed" call without the checksum →
   `curl -i -X POST https://crm.itarang.com/api/webhooks/digio -d '{}'` → 401.
   A real Digio and Bolna event still arrives.

## Way back

- `API_AUTH_GATE=report` (or remove the line), then reload.
- `WEBHOOK_AUTH_STRICT=` (empty), then reload.

The cron fail-closed behaviour has no switch: if a job stops, set
`CRON_SECRET`.
