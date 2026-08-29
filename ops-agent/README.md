# ops-agent

The host agent for the iTarang Ops Console (`/operations`).

Reads this box's vitals every 5 minutes and POSTs them to
`/api/operations/ingest/host`. The CRM never SSHes into anything — this push is
the only way host metrics reach the dashboard.

Dependency-free Node (18+). It is copied to boxes that may not have the repo's
`node_modules`, and it must keep running while a deploy is half-finished.

## What it reads

| Source | Metrics |
| --- | --- |
| `node:os` | `cpu_pct` (load ÷ cores), `load1`, `mem_used_pct`, `uptime_s` |
| `df -P -k /` | `disk_used_pct`, `disk_free_gb` |
| `df -P -i /` | `inode_used_pct` |
| `free -m` | `swap_used_pct` |
| `pm2 jlist` | per-process `status`, `restarts`, `mem_mb`, `cpu_pct`, `uptime_s` |
| `openssl s_client` + `x509 -enddate` | `cert_days_left` |

Every reader fails soft. A box without `free`, or one where pm2 is not
installed, loses that metric and nothing else — the cycle still posts.

Missing readings are **omitted**, never sent as `0`. A zero would render on the
dashboard as a real measurement and hide the gap.

## Log forwarding

The agent also tails log files and forwards new lines to `/operations/logs`.

**Set `OPS_LOG_DIR`, or the CRM's own logs are never read.** The agent runs with
`cwd` set to its own directory — deliberately, so it survives a half-finished
deploy — so a relative path like `logs/web.out.log` resolves next to the *agent*,
where only `ops-agent.out.log` lives. `OPS_LOG_DIR` is the directory holding the
CRM's `web.out.log`; relative entries in `OPS_LOG_FILES` resolve against it, and
the two pm2 defaults are only added when it is set. Absolute paths in
`OPS_LOG_FILES` ignore it entirely.

This used to be a default that could not work, and it failed *silently*: a
missing log file is skipped without complaint (nginx genuinely is absent on some
boxes), so the agent posted metrics happily while forwarding nothing and the
Logs & Errors page sat empty with no diagnostic anywhere. The agent now prints
every configured file and whether it is readable, once at startup — which the
`OPS_ONCE=1` smoke test below shows you:

```
[ops-agent] log itarang-crm-web: /…/shared/logs/web.out.log — ok
[ops-agent] log itarang-crm-web: /…/shared/logs/web.err.log — not found (will be picked up if it appears)
[ops-agent] log nginx: /var/log/nginx/error.log — NOT READABLE by this user
```

`NOT READABLE` and `not found` are different fixes: the first is permissions
(nginx logs are often `root`-owned — add the agent's user to the `adm` group or
point at a readable copy), the second is a path that does not exist yet.

**Exactly once, by byte offset.** Each file's offset is remembered in a local
state file (`OPS_LOG_STATE_FILE`, default `.ops-agent-state.json` next to the
agent). Every cycle reads from that offset to EOF. Not `tail -n`: a line count
cannot express "everything written since five minutes ago".

Four behaviours worth knowing:

- **First sight of a file ships nothing.** The offset starts at the current end.
  Forwarding a months-old log on install would bury today's errors and blow
  through the 14-day retention in one POST.
- **Rotation is detected** by the file being shorter than the stored offset, and
  reading restarts from 0.
- **Offsets advance only after the POST succeeds.** If the CRM is down for a
  cycle, the same lines ship on the next one instead of being lost — which is
  exactly when you want them. `MAX_TAIL_BYTES` (256 KB per file per cycle)
  bounds how far the backlog can grow meanwhile.
- **A half-written trailing line waits** for its newline, so it arrives whole
  rather than truncated.

**Level detection**, most explicit signal first: nginx's `[error]` bracket, then
an uppercase level token (`INFO`, `WARN`, `ERROR`…), then keywords, and only
then the stream (`*.err.log` ⇒ at least `warn`). A line that says what it is
always beats a guess about it.

**Only `warn` and above are forwarded by default.** `web.out.log` is
request-level chatter on a busy box; forwarding `info` would exhaust the 200-line
per-POST budget every cycle and bury the errors. Set `OPS_LOG_MIN_LEVEL=info`
deliberately if you want everything.

Server side, each line is truncated to 2000 chars and fingerprinted (a hash of
service + level + the message with ids, numbers and timestamps normalised out)
so the explorer can say "this error, 4,812 times" instead of rendering 4,812
rows.

## Configuration

All via environment variables:

| Var | Required | Notes |
| --- | --- | --- |
| `OPS_INGEST_URL` | yes | e.g. `https://crm.itarang.com/api/operations/ingest/host` |
| `OPS_INGEST_SECRET` | yes | must equal the CRM's `OPS_INGEST_SECRET` |
| `OPS_HOST_NAME` | yes | one of `prod`, `sandbox`, `iot` — must appear in the CRM's `OPS_INGEST_HOSTS` |
| `OPS_CERT_DOMAIN` | no | domain to check TLS expiry for; omit to skip the check |
| `OPS_INTERVAL_MS` | no | default `300000` (5 min) |
| `OPS_ONCE` | no | `1` = run one cycle and exit (cron mode) |
| `OPS_LOG_DIR` | **effectively yes** | Directory holding the CRM's `web.out.log`. Without it the pm2 defaults are not added at all and only nginx is tailed — see "Log forwarding" |
| `OPS_LOG_FILES` | no | comma-separated `service:path`. Default: `itarang-crm-web:web.out.log,itarang-crm-web:web.err.log` (added **only when `OPS_LOG_DIR` is set**, and resolved against it) plus `nginx:/var/log/nginx/error.log` |
| `OPS_LOG_STATE_FILE` | no | where byte offsets are remembered; default `.ops-agent-state.json` beside the agent |
| `OPS_LOG_MIN_LEVEL` | no | `error`\|`warn`\|`info`; default `warn` |
| `OPS_ENV_FILE` | no | Path to an env file `install.sh` reads `OPS_*` from. Defaults to probing `../shared/.env` then `../../shared/.env`. Set by the GitHub workflow |

Relative entries in `OPS_LOG_FILES` resolve against `OPS_LOG_DIR`, **not** against
the agent's cwd. Absolute paths ignore `OPS_LOG_DIR` entirely. If `OPS_LOG_DIR`
is unset, the two pm2 defaults are omitted rather than resolved to a path that
cannot exist — a relative default resolved next to the *agent*, where only
`ops-agent.out.log` lives, which is the bug fixed in 34b9db4b.

`install.sh` **strips surrounding quotes** from values read out of an env file.
`OPS_INGEST_SECRET="abc123"` in `shared/.env` used to be exported with the quote
characters included, so the CRM saw a different string and answered `401` — for
a secret that was correct. It also lets an **already-exported** value win over
the file, so the workflow's deliberate `OPS_LOG_DIR` is not silently overridden
by a stale line on the box.

### CRM side

Set these on the CRM, not on the agent box:

```
OPS_INGEST_SECRET=<same value the agent sends>
OPS_INGEST_HOSTS=prod,sandbox,iot
```

> **Prod's `shared/.env` is rewritten from the `PROD_ENV_FILE_B64` GitHub secret
> on every deploy.** Both vars must be added to the box **and** to that secret,
> or they vanish on the next deploy and ingest starts answering 503.
>
> **Sandbox's `shared/.env` is seeded once and edited on the box.** Changing the
> GitHub env secret does *not* propagate there — edit it on the box.

## Install

Use `install.sh` — it validates the configuration, runs one real cycle, and
refuses to daemonise an agent that would not work:

```bash
scp -r ops-agent/ user@box:~/ops-agent
ssh user@box
cd ~/ops-agent

export OPS_INGEST_URL=https://crm.itarang.com/api/operations/ingest/host
export OPS_INGEST_SECRET=...        # must equal the CRM's
export OPS_HOST_NAME=prod           # must be in the CRM's OPS_INGEST_HOSTS
export OPS_CERT_DOMAIN=crm.itarang.com
# OPS_LOG_DIR is auto-detected from ../shared/logs when the agent sits beside
# the app; set it explicitly otherwise.

./install.sh --dry-run    # validate + smoke-test, touch nothing
./install.sh              # then start under pm2 and pm2 save
```

It reads `OPS_*` from the box's `shared/.env` when they are not exported, checks
node ≥ 18, prints which log files are readable, and translates the three failures
that are otherwise invisible: 401 (wrong secret), 403 (host not in
`OPS_INGEST_HOSTS`), 503 (CRM not configured). Re-running is safe — an existing
`ops-agent` process is deleted and recreated so a changed variable actually takes
effect, which `pm2 restart` would not do.

<details>
<summary>Manual steps, if you would rather not use the script</summary>

```bash
# 1. Copy the directory to the box (any path; ~/ops-agent is fine)
scp -r ops-agent/ user@box:~/ops-agent

# 2. Export the config (or append it to the box's shared/.env)
export OPS_INGEST_URL=https://crm.itarang.com/api/operations/ingest/host
export OPS_INGEST_SECRET=...
export OPS_HOST_NAME=prod
export OPS_CERT_DOMAIN=crm.itarang.com
# Where the CRM's pm2 logs live — the directory holding web.out.log.
# WITHOUT THIS, ONLY NGINX IS TAILED and Logs & Errors stays empty of app
# errors. The agent runs from its own directory, so a relative path would
# resolve next to the agent, not next to the CRM. See "Log forwarding".
export OPS_LOG_DIR=/home/itarang-crm/htdocs/crm.itarang.com/shared/logs

# 3. Smoke-test one cycle before daemonising
OPS_ONCE=1 node ~/ops-agent/agent.js

# 4. Run it under pm2 and make it survive a reboot
cd ~/ops-agent
pm2 start ecosystem.ops-agent.config.js
pm2 save
```

`OPS_ONCE=1` prints `sent N metrics, M processes for host=<name>` on success.
Anything else is the error — see below. Note the agent exits 0 even when the
POST is rejected (a daemon must survive a CRM that is briefly down), so check
for that line rather than the exit code — which is what `install.sh` does.

</details>

### cron instead of pm2

If you would rather not add a pm2 process:

```cron
*/5 * * * * OPS_ONCE=1 /usr/bin/node /home/user/ops-agent/agent.js >> /home/user/ops-agent/logs/cron.log 2>&1
```

The env vars must be set in the crontab or sourced in a wrapper — cron does not
read the box's shell profile.

## Verifying

1. `/operations/jobs` shows the `infra.host` collector completing.
2. `/operations/infrastructure` shows a card for the host with a fresh
   "last seen" — that is `host.agent_age_min`, which is what tells you the agent
   itself is alive.

A rising `host.agent_age_min` means the agent, or the box, is gone and **every
other number for that host is stale**. That is the metric to alert on, not the
individual vitals.

## Troubleshooting

| Response | Meaning |
| --- | --- |
| `401 Unauthorized` | `OPS_INGEST_SECRET` differs between agent and CRM |
| `403 Host not allowed` | `OPS_HOST_NAME` is not in the CRM's `OPS_INGEST_HOSTS` |
| `413 Payload too large` | >512 KB body — only reachable once Phase 3 sends logs |
| `422 captured_at is N minutes from server time` | the box's clock has drifted; fix NTP |
| `429 Rate limited` | more than one post per host per minute; check for a duplicate agent |
| `500 relation "ops_metric_samples" does not exist` | `drizzle/E-210_ops_monitoring.sql` is not applied on that environment |
| `503 Ingest is not configured` | `OPS_INGEST_SECRET` or `OPS_INGEST_HOSTS` is unset on the CRM |
