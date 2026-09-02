# Ops Console — Logs & Errors rollout runbook

Sandbox first, production only after sandbox is proven. Every step has a **stop
condition**: if the check fails, fix it before moving on. Skipping ahead is how
this ends up looking installed and forwarding nothing.

---

## Why this document exists

`/operations/logs` is empty. Not because of a bug in the query layer, and not
because the table is missing — `drizzle/E-210_ops_monitoring.sql` is marked
applied in all four environments in `drizzle/MIGRATION_CHECKLIST.md`, and
`ops_log_events` exists on the sandbox database. It has **0 rows, and has never
had any**.

Nothing has ever written to it, because nothing that writes to it has been
deployed:

```
$ git rev-list --left-right --count origin/main...HEAD
0    17
$ git branch -r --contains 3acdc1a7      # "feat(operations): Ops Console (E-210)"
                                          # (no output — on no remote branch)
```

The entire Ops Console is 17 unpushed commits on a local branch. So on sandbox
today:

- `POST /api/operations/ingest/host` → **404** (route not deployed). The agent
  logs `cycle failed: HTTP 404` and carries on forever.
- `/operations/logs` does not exist.
- `.github/workflows/ops-agent.yml` is not on the default branch, so GitHub does
  not render a **Run workflow** button for it. `workflow_dispatch` only lists
  workflows present on the repo's default branch. **Merging is a prerequisite,
  not a formality.**

The agent has never been installed on any box.

---

## Step 1 — Ship the code

Push the branch and merge to `main`.

**Stop condition:** `.github/workflows/ops-agent.yml` is on the default branch,
and the **ops-agent (manual)** workflow appears under the repo's Actions tab with
a *Run workflow* button. If there is no button, nothing below can run.

## Step 2 — Deploy sandbox

Run the sandbox deploy as normal.

**Stop condition:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://sandbox.itarang.com/api/operations/ingest/host
```

Expect **503** (`Ingest is not configured on this environment`). 503 is the
*good* answer here — it proves the route is deployed and is refusing because the
CRM has no secret yet. **404 means the deploy did not include the route**; stop
and fix that. A 401 would mean the secret is already set, which is also fine.

Also confirm `/operations/logs` loads (it will be empty).

## Step 3 — Configure the sandbox box

Two halves, both in `/home/itarang-sandbox/htdocs/sandbox.itarang.com/shared/.env`.

CRM side (what the ingest endpoint checks):

```
OPS_INGEST_SECRET=<generate a long random string>
OPS_INGEST_HOSTS=sandbox
```

Agent side (what the agent sends):

```
OPS_INGEST_URL=https://sandbox.itarang.com/api/operations/ingest/host
OPS_HOST_NAME=sandbox
OPS_CERT_DOMAIN=sandbox.itarang.com
```

Three things that will bite:

- **`OPS_HOST_NAME` must appear in `OPS_INGEST_HOSTS`** or every post is a 403.
  Here both say `sandbox`. Note the host name and the pm2 *process* name are
  different namespaces — the pm2 app is `sandbox-web`, the host is `sandbox`.
- **Sandbox's `shared/.env` is seed-once.** `deploy-sandbox.yml` only copies it
  if it does not already exist. Editing the `SANDBOX_ENV_FILE_B64` GitHub secret
  does **not** propagate to the box. Edit it on the box.
- **Quoting no longer breaks the secret**, but prefer unquoted values anyway.
  `install.sh` now strips one surrounding pair of quotes; before that fix,
  `OPS_INGEST_SECRET="abc"` was exported *with* the quotes and produced a 401
  that read as "wrong secret" for a correct secret.

Alternatively, set the agent-side trio as GitHub secrets — `SANDBOX_OPS_INGEST_URL`,
`SANDBOX_OPS_INGEST_SECRET`, `SANDBOX_OPS_HOST_NAME`, `SANDBOX_OPS_CERT_DOMAIN` —
and the workflow supplies them. The CRM-side pair must still be in `shared/.env`,
because that is the running server's environment.

## Step 4 — Restart sandbox web

The CRM reads `OPS_INGEST_SECRET` from its own process environment, so it needs
a restart to see the new lines.

```bash
pm2 restart sandbox-web --update-env
```

**Stop condition:** the `curl` from step 2 now returns **401** (not 503). 401
means the CRM has a secret and is rejecting an unauthenticated request, which is
exactly right.

## Step 5 — Dry run

Actions → **ops-agent (manual)** → Run workflow → environment `sandbox`, mode
`dry-run`. These are the defaults, so a mis-click validates rather than starts.

**Stop condition:** the job succeeds and its log contains

```
[ops-agent] sent N metrics, M processes for host=sandbox
```

and the log-file report shows the CRM's files as `ok`:

```
[ops-agent] log itarang-crm-web: /…/shared/logs/web.out.log — ok
[ops-agent] log itarang-crm-web: /…/shared/logs/web.err.log — ok
[ops-agent] log nginx: /var/log/nginx/error.log — NOT READABLE by this user
```

`nginx: NOT READABLE` is acceptable — nginx logs are root-owned and the agent
runs as `itarang-sandbox`. Add that user to the `adm` group later if you want
nginx errors too. **`NOT READABLE` on `web.out.log` is not acceptable**, and
neither is a missing `sent … metrics` line.

If it fails, `install.sh` prints the translation:

| Response | Cause |
| --- | --- |
| 401 | `OPS_INGEST_SECRET` differs between agent and CRM |
| 403 | `OPS_HOST_NAME` is not in the CRM's `OPS_INGEST_HOSTS` |
| 503 | the CRM has no `OPS_INGEST_SECRET`/`OPS_INGEST_HOSTS` (did you restart it?) |
| 404 | the route is not deployed — step 2 was not actually done |
| ECONNREFUSED | `OPS_INGEST_URL` wrong, or the box cannot reach the CRM |

**Do not proceed until this run is green.** Nothing has been started yet.

## Step 6 — Install

Same workflow, environment `sandbox`, mode `install`. It re-runs every check
from the dry run, then daemonises under pm2 and runs `pm2 save` so the agent
survives a reboot.

**Stop condition:** the job succeeds, and on the box `pm2 describe ops-agent`
shows it online.

## Step 7 — Generate a test log line

**The agent never backfills.** On first sight of a file it seeks to the end, so
only lines written *after* the install are forwarded. Only `warn` and above are
forwarded by default. So an empty page right after installing is correct
behaviour, not a fault — you have to write a line.

On the box:

```bash
echo "$(date -Iseconds) ERROR ops-agent rollout smoke test $(date +%s)" \
  >> /home/itarang-sandbox/htdocs/sandbox.itarang.com/shared/logs/web.err.log
```

Then either wait one 5-minute cycle, or force one:

```bash
cd /home/itarang-sandbox/ops-agent && OPS_ONCE=1 node agent.js
```

The unique timestamp at the end makes the line findable and proves it is *this*
test rather than an earlier one.

## Step 8 — Confirm it arrived

**Stop condition, all three:**

1. `/operations/logs` shows the line (search for the timestamp you appended).
2. `/operations/infrastructure` shows host `sandbox` with a fresh
   **Agent last seen** — that is `host.agent_age_min`. A rising value means the
   agent or the box is gone and *every other number for that host is stale*;
   it is the metric to alert on, not the individual vitals.
3. `/operations/jobs` shows the `infra.host` collector completing.

Sandbox is now proven.

---

## Production — requires explicit approval

Do not start this until sandbox has been through steps 1–8 successfully.

The procedure is the same, with three differences:

1. **`shared/.env` is rewritten on every deploy.** `deploy-production.yml` runs
   an unconditional `base64 -d "$ENV_B64" > shared/.env`. Any `OPS_*` line added
   by hand on the prod box — CRM-side *or* agent-side — is **erased by the next
   release**, and ingest silently starts answering 503 while the agent logs
   `cycle failed` into a file nobody is reading. Both `OPS_INGEST_SECRET` and
   `OPS_INGEST_HOSTS` must be added to the **`PROD_ENV_FILE_B64` secret**, not
   just to the box. This is the single most likely way a working production
   install quietly stops working weeks later.
2. **Different values.** `OPS_HOST_NAME=prod`, `OPS_INGEST_HOSTS` must contain
   `prod`, `OPS_INGEST_URL=https://crm.itarang.com/api/operations/ingest/host`,
   `OPS_CERT_DOMAIN=crm.itarang.com`. Use a **different** ingest secret from
   sandbox. The workflow reads the prod trio from `PROD_OPS_*` secrets, which
   share no name with the `SANDBOX_OPS_*` set, so neither environment can be
   configured with the other's values by a typo in one place.
3. **A second gate.** The production job declares `environment: production`.
   Configure a required reviewer on that environment in repo settings so a
   production run needs an approval.

Run `dry-run` against production first, exactly as with sandbox, and stop on
anything other than a clean `sent N metrics`.
