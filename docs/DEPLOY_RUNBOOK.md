# CI/CD Deploy Runbook

How the GitHub Actions deploy pipeline for `crm.itarang.com` and
`sandbox.itarang.com` works, what secrets it needs, and how to recover
when something goes wrong.

## TL;DR

| You did | What happens |
|---|---|
| `git push origin main` | Auto-deploys to `sandbox.itarang.com` (drizzle db:push, build, pm2 restart, /api/health probe, rollback on fail, Slack notify) |
| `git push origin production` | Auto-deploys to `crm.itarang.com` (NO db:push — refuses if new migrations detected; you apply them manually first) |
| Workflow tab → "Run workflow" | Manually trigger either deploy from any branch (`workflow_dispatch`) |

Both workflows live in `.github/workflows/`:
- `deploy-sandbox.yml`
- `deploy-production.yml`

## Architecture

```
GitHub push ──→ GitHub-hosted Ubuntu runner ──ssh──→ Hostinger VPS
                                                       │
                                                       ├─ /home/itarang-sandbox/htdocs/sandbox.itarang.com/  (sandbox)
                                                       │     ├─ git pull, npm ci, db:push, npm build
                                                       │     ├─ pm2 restart sandbox-web + sandbox-worker (port 3003)
                                                       │     └─ poll /api/health for 60s
                                                       │
                                                       └─ /home/itarang-crm/htdocs/crm.itarang.com/        (production)
                                                             ├─ git pull, npm ci, npm build (NO db:push)
                                                             ├─ pm2 restart itarang-crm-web (port 3002)
                                                             └─ poll /api/health for 90s
```

## Required GitHub secrets

In repo `iTarangIT/itarang-software` → **Settings → Secrets and variables → Actions**:

### Sandbox lane

| Secret | Value |
|---|---|
| `SANDBOX_VPS_HOST` | `72.61.246.37` |
| `SANDBOX_VPS_USER` | `itarang-sandbox` (CloudPanel user) |
| `SANDBOX_VPS_PORT` | `22` |
| `SANDBOX_VPS_SSH_KEY` | private key (see "SSH key setup" below) |
| `SANDBOX_ENV_FILE_B64` | base64 of `.env` for the sandbox CRM |

### Production lane

| Secret | Value |
|---|---|
| `PROD_VPS_HOST` | `72.61.246.37` |
| `PROD_VPS_USER` | `itarang-crm` (CloudPanel user) |
| `PROD_VPS_PORT` | `22` |
| `PROD_VPS_SSH_KEY` | private key |
| `PROD_ENV_FILE_B64` | base64 of `.env.production` for prod |

### Shared

| Secret | Value |
|---|---|
| `SLACK_WEBHOOK_URL` | (optional) https://hooks.slack.com/services/... — silenced if not set |

## SSH key setup (one-time, per env)

On the VPS as the relevant user:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/itarang_deploy -N ""
cat ~/.ssh/itarang_deploy.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
cat ~/.ssh/itarang_deploy   # ← paste THIS into the GitHub secret
rm ~/.ssh/itarang_deploy ~/.ssh/itarang_deploy.pub  # then remove local copy for safety
```

## /api/health behavior

The deploy gate. Returns:

```json
{
  "ok": true,
  "commit": "abc123def456",
  "env": "production",
  "deps": {
    "crm_db":     { "ok": true, "ms": 12 },
    "iot_bridge": { "ok": true, "ms": 87 },
    "sandbox":    { "ok": true, "ms": 23 }
  },
  "elapsed_ms": 122
}
```

- **HTTP 200** when CRM Postgres is reachable (the only critical dep).
- **HTTP 503** when CRM DB is down → triggers deploy rollback.
- IoT bridge / Python sandbox are **soft deps** — they show as not-ok in the
  body but don't fail the probe. Without them, the NBFC dashboard degrades
  but the rest of the CRM works.

## Migration policy

- **Sandbox** (deploy-sandbox.yml): runs `npm run db:push` automatically
  after `npm ci`. Drizzle compares `schema.ts` to the live DB and applies
  the diff. Fast iteration, occasional surprise.
- **Production** (deploy-production.yml): does NOT run db:push. Instead:
  1. Computes `git diff PREV_SHA..NEW_SHA -- 'drizzle/0*.sql'`
  2. If any new migration files are detected, the deploy **fails** with a
     message asking you to apply them manually first.
  3. After applying via psql, re-trigger the workflow.

This prevents drizzle from auto-dropping a column on prod because of
schema-vs-DB drift.

## Rollback

Automatic on health-check failure:

1. Step 2 (deploy) saves `PREV_SHA` to `/tmp/itarang-{sandbox,prod}-prev-sha`
   before pulling.
2. Steps inside Step 2 fail loudly on first error (`set -eo pipefail`).
3. Step 3 (`if: failure()`) reads `PREV_SHA`, `git reset --hard $PREV_SHA`,
   reinstalls, rebuilds, restarts pm2.
4. Step 4 always runs and Slack-notifies the outcome including whether
   rollback succeeded.

If rollback also fails (e.g. DB is gone), the workflow finishes red and
Slack reports failure. Then you SSH in and recover by hand.

## Slack notifications

Two events per deploy: start (right when push triggers), result
(success / fail / rollback). Format:

```
🚀 Sandbox deploy started `abc1234`
by apoorvgupta — `feat: new risk hypothesis`
https://github.com/iTarangIT/itarang-software/commit/abc1234
```

```
✅ Sandbox deploy succeeded `abc1234`
Logs: https://github.com/iTarangIT/itarang-software/actions/runs/12345
```

To set up: Slack workspace → Apps → "Incoming Webhooks" → create one for
`#deploys` or whichever channel → copy the URL into `SLACK_WEBHOOK_URL`.
If the secret is empty, the steps are skipped silently.

## When something goes wrong

### Deploy keeps failing at health check

```bash
ssh itarang-sandbox@72.61.246.37
cd /home/itarang-sandbox/htdocs/sandbox.itarang.com
pm2 logs sandbox-web --lines 100
curl -v http://127.0.0.1:3003/api/health
# Compare to last good commit:
git log --oneline -5
```

Common causes:
- DATABASE_URL changed and the new code can't connect → fix env, redeploy
- Drizzle migration broke a table → connect to RDS via pgAdmin and inspect

### Rollback succeeded but I want a different version

```bash
ssh itarang-sandbox@72.61.246.37
cd /home/itarang-sandbox/htdocs/sandbox.itarang.com
git fetch origin main
git reset --hard <desired-sha>
npm ci
npm run build
pm2 restart sandbox-web sandbox-worker
```

### Production needs a hotfix RIGHT NOW (skip CI)

```bash
ssh itarang-crm@72.61.246.37
cd /home/itarang-crm/htdocs/crm.itarang.com
# fix the file directly
vim src/...
npm run build
pm2 restart itarang-crm-web
# THEN sync the change back to the production branch — otherwise next deploy will undo your hotfix
```

### Slack going noisy

Either remove `SLACK_WEBHOOK_URL` secret (silences both lanes) or change
the workflow to only notify on failures (`if: failure()` on the start
step).

## What's NOT yet automated

- **IoT stack** (poller, dashboard, risk-sandbox) — still deployed via the
  base64-bundled `phase*.sh` scripts. Phase 2 of CI/CD: create
  `iTarangIT/itarang-iot-stack` repo and add `.github/workflows/deploy-iot.yml`.
- **Schema migrations on the VPS Postgres** (telemetry DB) — manual.
- **Risk-sandbox** — now versioned at `services/risk-sandbox/` (was an
  unversioned `phase6_risk_sandbox.sh` on the box). See its README to deploy.

## Cron — `vercel.json` does NOT fire on the VPS

⚠️ **The `crons` block in `vercel.json` is inert here.** We deploy on Hostinger
via PM2; Vercel cron only exists on Vercel. Every route listed there — including
`compute-cds` and `compute-pci`, which are documented as "nightly" — runs only if
something on the VPS actually calls it.

Evidence this bit us: on 2026-07-13, `borrower_risk_scores.computed_at` was last
written **2026-07-08**. The nightly CDS job had not run in five days.

The real mechanism is a crontab on the VPS. `crontab -e` as root, using the
same `CRON_SECRET` that is in the app's env (prod is port 3002, sandbox 3003):

```cron
CRON_SECRET=<same value as the app's env>

# NBFC risk + scoring. CDS first, then PCI (which reads the rows CDS writes),
# then the hypothesis engine.
0  0 * * * curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" http://127.0.0.1:3002/api/cron/nbfc/compute-cds       >> /var/log/itarang-cron.log 2>&1
15 0 * * * curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" http://127.0.0.1:3002/api/cron/nbfc/compute-pci       >> /var/log/itarang-cron.log 2>&1
30 1 * * * curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" http://127.0.0.1:3002/api/cron/nbfc/risk-analysis     >> /var/log/itarang-cron.log 2>&1
```

`risk-analysis` (E-187) sweeps every active tenant sequentially. It is safe to
run while someone is using the "Re-run analysis" button: the per-tenant lock
means that tenant is skipped rather than run twice. The whole sweep is
idempotent — re-running it just writes a fresher set of cards.

Check it landed: `tail -f /var/log/itarang-cron.log`, or query
`SELECT tenant_id, status, started_at, cards_computed FROM risk_runs ORDER BY started_at DESC LIMIT 5;`
