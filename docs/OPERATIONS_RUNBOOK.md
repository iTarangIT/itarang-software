# Ops Console — Runbook

`/operations` — the tech team's monitoring dashboard. Migration `E-210`.

Before this existed, "is iTarang healthy?" was answered from `/api/health` (curl
only), `pm2` on two VPS boxes (SSH only), `pg_stat_*` (psql only), ten vendor
billing portals, and Cost Analytics. A full disk, a dead background ticker or a
burnt ElevenLabs balance was invisible until a user reported a broken page.

**Design constraints, in case you are tempted otherwise:**

- It lives inside the CRM. No new app, infra, hosting or deploy pipeline.
- Server metrics and logs arrive by **push** from an agent on each box. The CRM
  never SSHes into anything.
- Pages read tables **only**. They never call a vendor, never shell out, never
  query a box. If a vendor is down, the dashboard still loads and shows
  stale-with-timestamp.

---

## 1. Rollout checklist

Do these in order. Steps 1–3 are required before anyone can open the console.

### 1. Apply the migration

Paste `drizzle/E-210_ops_monitoring.sql` into the Supabase SQL editor / pgAdmin
against **database-1 (sandbox)** and **database-2 (prod)**. Re-running it is a
no-op — every statement is `IF NOT EXISTS`.

Then tick the row in `drizzle/MIGRATION_CHECKLIST.md`.

Verify: six tables (`ops_metric_samples`, `ops_daily_snapshots`,
`ops_collector_runs`, `ops_log_events`, `ops_alert_rules`, `ops_alerts`) and 21
indexes, including the two partial uniques that are load-bearing concurrency
control:

```sql
-- the single-flight lock
ops_collector_runs (collector_id) WHERE status = 'running'
-- alert dedup: one open alert per metric+source
ops_alerts (metric_key, source) WHERE resolved_at IS NULL
```

**Symptom if skipped:** every page shows an "apply E-210" card, and the ingest
route answers `500 relation "ops_metric_samples" does not exist`.

Also apply `drizzle/E-211_ai_call_logs_provider_idx.sql` — one index,
`ai_call_logs (provider, ended_at DESC)`, behind `/operations/elevenlabs`.
Unlike E-210 this one is a **performance** fix, not a correctness one: the page
works without it, but every panel filters by `provider` (unindexed before this)
and the all-time total is deliberately unbounded, at a 60-second auto-refresh.

**Symptom if skipped:** `/operations/elevenlabs` renders correctly but slowly,
and the load lands on the same RDS instance the console exists to protect.

### 2. Create the login

```bash
npm run seed:operations-user   # once against sandbox, once against prod
```

Creates `operations@itarang.com` in **both** Supabase auth (`app_metadata.role`,
which middleware reads) and the `users` row (which every page and API guard
reads). Keyed on the Supabase auth UUID, never on email.

> Default password is fine for sandbox. **Rotate it on prod** — this login can
> read company spend and infrastructure detail.

**This also gates alerting.** In-app delivery is `notifyRoles(["operations"])`,
which inserts one row per *active user with that role*. With no such user it
inserts zero rows and the alert appears on the page but notifies nobody.

### 3. Set the ingest secrets

On the CRM (not the agent box):

```
OPS_INGEST_SECRET=<long random string>
OPS_INGEST_HOSTS=prod,sandbox,iot
```

Optional:

| Var | Effect |
| --- | --- |
| `ENABLE_OPS_MONITOR=0` | disables the collector ticker on this process |
| `OPS_ALERT_EMAIL` | recipient for email alerts; without it the email channel no-ops |

> **Prod's `shared/.env` is rewritten from the `PROD_ENV_FILE_B64` GitHub secret
> on every deploy.** Add these to the box **and** re-base64 `.env.production`
> into that secret, or they vanish on the next deploy.
>
> **Sandbox's `shared/.env` is seeded once and edited on the box.** Changing the
> GitHub secret does *not* propagate there.

### 4. Install the host agent

> **Doing this for the first time? Follow
> [`docs/OPS_AGENT_ROLLOUT.md`](./OPS_AGENT_ROLLOUT.md) instead** — the
> sandbox-first runbook, with a stop condition on every step. It covers the
> prerequisite most people miss: the Ops Console and its `ops-agent` workflow
> must be on the repo's DEFAULT BRANCH and deployed before any of this can work,
> or the agent posts into a 404 and reports nothing wrong.

Per box — see `ops-agent/README.md` for the full procedure. Prefer
`.github/workflows/ops-agent.yml` (manual dispatch, sandbox + dry-run by
default) over hand-running the commands below: nobody holds the VPS deploy key
locally.

```bash
scp -r ops-agent/ user@box:~/ops-agent
# export OPS_INGEST_URL / OPS_INGEST_SECRET / OPS_HOST_NAME / OPS_CERT_DOMAIN
OPS_ONCE=1 node ~/ops-agent/agent.js        # smoke test one cycle
cd ~/ops-agent && pm2 start ecosystem.ops-agent.config.js && pm2 save
```

`pm2 save` is what makes the agent survive a box reboot. Without it the agent is
gone after the next restart and `host.agent_age_min` climbs forever.

### 5. Confirm it works

1. `/operations/jobs` — every collector shows a recent completed run.
2. `/operations/database` — connection headroom is populated (this is the
   highest-value number in the build).
3. `/operations/infrastructure` — a card per host with a fresh "agent seen".
4. `/operations` — the board has tiles and the freshness footer is green.

---

## 2. How it runs

One in-process ticker, registered in `src/instrumentation.ts`, started 75s after
boot and firing every 60s. Each tick:

1. **Run due collectors.** Each declares its own `intervalMs`; the runner only
   executes the ones whose last *start* is older than that. One timer,
   per-collector cadence.
2. **Evaluate thresholds** against `ops_alert_rules` — every tick, not only when
   a collector fired.
3. **At 00:15 IST**, once per day: freeze yesterday into `ops_daily_snapshots`,
   prune samples to 30 days and logs to 14 days.

> **Not Vercel cron, not BullMQ.** `vercel.json` crons do not fire on the PM2
> boxes, and no BullMQ worker is declared in production. The in-process ticker is
> the only mechanism that provably runs on both sandbox and prod.

Collectors are isolated: a failing one records its own failed run and the others
carry on. A monitoring system that goes dark because one vendor timed out is
worse than none, because it looks green.

---

## 3. The pages

| Page | Shows | Fed by |
| --- | --- | --- |
| `/operations` | Traffic-light board of every `onSlide` metric, live vs yesterday's snapshot, open alerts, deploy SHA per env | everything |
| `/operations/infrastructure` | CPU, memory, disk, inodes, swap, SSL, pm2 table, 24h sparklines | agent **push** |
| `/operations/database` | RDS connection headroom, query/idle-tx age, cache hit, top tables, schema drift | `db.rds` collector |
| `/operations/logs` | Errors grouped by fingerprint, filters, rate chart, Excel export | agent **push** |
| `/operations/system` | Dependency up/down + latency + uptime %, Upstash circuit, job liveness, deploy SHA | `system.app_health` + `system.jobs` |
| `/operations/spend` | Monthly burn, MoM, vendor credit balances, metered-vs-billed | `spend.*` + `vendor.*` |
| `/operations/business` | CEO metrics mirrored, live vs collected | `business.mtd` |
| `/operations/team` | Licence usage, actions by role, top actors — **aggregate only** | `team.usage` |
| `/operations/usage` | Logins, DAU/WAU/MAU, session duration, login history — **per-person, see §8** | `usage.activity` + `user_login_events` |
| `/operations/alerts` | Open alerts, ack/resolve, editable thresholds | `ops_alerts` |
| `/operations/jobs` | Every collector's last run — **is the monitoring itself alive?** | `ops_collector_runs` |
| `/operations/elevenlabs` | Credits, quota, daily/monthly call volume, usage by campaign category, recent calls — **is sales actually using it?** | `vendor.elevenlabs` sample + `ai_call_logs` read live |

**Start at `/operations/jobs` when anything looks wrong.** If the collectors are
not running, every other page is showing history, and the freshness footer on
the board is the only thing that will tell you.

---

## 4. Adding a metric

Three edits, nothing else in the system changes:

1. A collector file under `src/lib/operations/collectors/` returning
   `CollectedSample[]`. It performs no writes and knows nothing about
   scheduling, locking or alerting — the runner owns all of that.
2. One or more entries in `src/lib/operations/registry.ts`.
3. One line in `src/lib/operations/collectors/index.ts`.

Pages, thresholds, alerting and the board all read from the registry.

**Registry rules** (enforced by `__tests__/registry.test.ts`):

- Keys are dot-namespaced and **append-only** — renaming one orphans its
  history in `ops_metric_samples` and `ops_daily_snapshots`.
- `warn` must sit on the correct side of `crit` for the metric's `direction`,
  or the warning level is unreachable.
- `neutral` metrics must not carry thresholds — they would seed a rule that is
  never evaluated.
- Keep `onSlide` short. The board's whole value is fitting one screen.

**Units:** money is INR **paise** throughout; bytes are bytes; percents are
0–100. `ai_call_logs.*_cost_cents` and `expense_submissions.amount` are already
INR — never apply an FX rate to either.

---

## 5. When an alert fires

Thresholds seed from the registry and are then **owned by whoever edits them** on
`/operations/alerts` — the seed uses `ON CONFLICT DO NOTHING`, so a hand-tuned
value survives every deploy.

| Alert | What it means | First move |
| --- | --- | --- |
| `db.connections_pct` / `db.connections_used` | RDS has ~79 `max_connections` and **no pooler**. A deploy burst trips `53300`, which fails `/api/health` and rolls the deploy back. | Check for a process opening its own pool. `src/lib/db/index.ts` caps at `max: 5` for this reason. |
| `host.disk_used_pct` | A full disk takes the app down hard and silently. Has happened here before via runaway logging. | Check `logs/` sizes. `src/lib/log.ts` rate-limits for this reason. |
| `host.inode_used_pct` | Inode exhaustion looks exactly like a full disk while `df` shows free space. | Millions of small files somewhere. |
| `host.agent_age_min` | The agent — or the box — is gone. **Every other metric for that host is stale.** | Alert on this one, not the individual vitals. |
| `host.cert_days_left` | An expired cert takes down the whole site, including this dashboard. | Renew, then confirm nginx reloaded — the check reads the *served* cert precisely to catch that. |
| `job.last_run_age_min` / `job.last_run_failed` | A background job stopped or is failing. This is the metric that would have caught the Zoho sync ticker being dead on prod. | `/operations/jobs`, then the job's own run table. |
| `vendor.credits_remaining` | A metered vendor plan is running out. Nothing else polls this. Thresholds are sized in **runway**, not round numbers: warn 40,000 ≈ 10 days at ElevenLabs' peak burn (~3.8k/day), crit 15,000 ≈ 4 days (E-212). | Open `/operations/elevenlabs` — the daily chart tells you whether the burn is steady or a spike, which decides whether to top up or to stop a runaway campaign. Then top up before calls start failing. |
| `business.leads_created_mtd` | Zero leads mid-month is a **broken ingest**, not a quiet week. | Check the scraper and lead API routes. |

**Acknowledge vs resolve.** Acknowledging marks an alert as seen; it stays open
while the condition holds. Resolving closes it — and it will re-open on the next
tick if the breach is still live. That is correct, not a bug.

An alert auto-resolves only when a **fresh** sample says the metric is healthy. A
metric that stops arriving leaves its alert open, because "we stopped hearing
about the disk" is not "the disk got better".

**A recovery notice is only sent if the warning was.** An alert that opened and
cleared inside one cooldown window never notified anyone, so "Recovered: X" for
an X nobody heard about is withheld — it still appears on `/operations/alerts`
with its full history. The resolve itself is never delayed.

**Per-source thresholds.** `ops_alert_rules.source` is `'*'` by default, meaning
one rule covers every source of its metric. A rule scoped to a specific source
(`vendor:elevenlabs`, `host:prod`) now **shadows** the `'*'` rule for that source
and only that source; everything else still falls through to the wildcard. See
`src/lib/operations/alertRouting.ts`.

> Before this existed, both rules evaluated the same sample and fought over the
> single alert row that `(metric_key, source) WHERE resolved_at IS NULL` allows —
> one opening it and the other resolving it every 60-second tick, notifying twice
> each time. If you ever see an alert opening and closing on a loop, look for two
> rules covering one source.

**Creating one.** `/operations/alerts` → **+ Per-source override**, under the
thresholds table. Both dropdowns list only what is actually reporting (metrics
from the registry, sources seen in the last 48h), so you cannot typo a source
into a rule that silently matches nothing. Thresholds prefill from the `'*'` rule
so you edit the difference. The comparator is shown but not editable — it comes
from the metric's direction in `registry.ts`, and a rule allowed to disagree with
its metric would invert the alert while looking correct.

Two guards worth knowing, both enforced server-side:

- **An override needs at least one threshold.** With neither it can never fire,
  and because it shadows `'*'` it would leave that source unmonitored — strictly
  worse than not creating it.
- **Warn must sit on the reachable side of crit.** `severityForRule` checks crit
  first, so an inverted pair means the value trips critical before warn can ever
  fire. Applies to edits too, not just new rules.

**Removing one.** Delete it from its row — the source returns to the `'*'` rule
on the next tick, and any alert still open resolves normally under the wildcard's
thresholds. Alert history survives (`ops_alerts.rule_id` is deliberately not a
foreign key). Disabling instead of deleting has the same routing effect and keeps
the row. The `'*'` rows themselves cannot be deleted: `seedAlertRules()` would
recreate them from the registry defaults on the next tick, silently discarding
whatever they had been tuned to — disable them instead.

---

## 6. Known landmines

1. **Migrations do not auto-run.** An unapplied `E-` file surfaces at runtime as
   `relation "x" does not exist` — Drizzle names every column in its INSERTs.
2. **Never `npm run db:push` against sandbox or prod.** It is diff-based and
   will drop columns. `expense_submissions` currently has **11 columns in the
   database that `schema.ts` does not declare** (`bucket`, `currency`,
   `fx_rate`, `original_amount`, …) — `db:push` would delete all of them.
   The spend module detects `bucket` at runtime and falls back to `department`.
3. **`scraper_runs` is declared twice** in `schema.ts` (`scraperRuns` and
   `scrapeRuns`, same table, divergent columns). The jobs collector reads it by
   raw SQL to sidestep the ambiguity.
4. **`risk_card_runs` is shaped differently** from every other `*_runs` table —
   it uses `run_at`, has no `status`, and is one row per card evaluation rather
   than a job lifecycle.
5. **`/api/system/database-monitor` queries the IoT database, not RDS**, despite
   its name and its `requireRole(['ceo'])` gate. Do not reuse it.
6. **`src/app/api/dashboard/[role]/route.ts` still has its own inline copies** of
   the CEO aggregations that `src/lib/dashboard/ceoMetrics.ts` mirrors. They
   match today and `/operations/business` shows live-vs-collected so drift is
   visible — but a change in one must be made in the other until the route is
   switched to import from the module.
7. **`npm run type-check` and `npm run lint` are already red on a clean tree.**
   Filter to your touched files. `tsc` also needs
   `NODE_OPTIONS=--max-old-space-size=8192` or it runs out of heap.
8. **Postgres `numeric` returns as a STRING.** Every read path must go through
   `toNumber()` in `format.ts`. Missing it made `formatMetricValue` throw
   `.toFixed is not a function` on a percent-unit alert.
9. **A raw `sql` template cannot bind a JS `Date`.** The Drizzle query builder
   serialises Dates; a raw template hands the value to postgres-js, which
   throws. Pass `.toISOString()` with an explicit `::timestamptz`.

---

## 7. Verifying a change

```bash
NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit   # filter to your files
npx eslint src/lib/operations "src/app/(dashboard)/operations" "src/app/api/operations"
npx vitest run src/lib/operations                          # 102 unit tests, no DB
```

The unit tests are pure by design — `vitest.config.ts` is scoped to no-I/O
suites, which is why validation, scheduling and threshold logic live in modules
that do not import `db`.

Anything touching the database is verified against sandbox by running the
collector directly. There is no fixture harness; the tables are cheap to read
and the data is real.

---

## 8. User usage analytics — what we record, and the promise attached to it

`/operations/usage` is the only surface in this codebase that holds **per-person**
records. Everything else in the console is aggregate. That difference is not an
implementation detail — it is the thing this section exists to keep honest.

### What is recorded

| Table | Row | Retention |
| --- | --- | --- |
| `user_login_events` | one per credential entry — user, time, role at the time | **90 days** |
| `user_activity_sessions` | one per CRM session — start, last seen, heartbeat count | **30 days** |
| `module_usage_daily` | daily **aggregate** counters per module — no user id | permanent |
| `module_visit_keys` | scratch dedupe hashes behind the above | **2 days** |
| `ops_daily_snapshots` | daily **aggregates only** (`usage.*`) | permanent |

### What is NOT recorded — deliberately

**No IP address. No user-agent or device. No page paths or URLs. No search terms.
No field contents. No failed login attempts.**

None of the metrics this feature exists for needs any of them, and each one turns
a usage table into a forensics table. If security later needs a source IP for an
"unexpected login location" check, it belongs additively on `user_login_events`,
where it answers a security question — **not** on the session table.

### Per-module usage (E-215) — and why it is not a page path

Module tracking is the one feature that looked like it needed the URL, so it is
worth being exact about why the promise above still holds.

The browser resolves its own location against a **closed seven-value allow-list**
(`MODULES` in `src/lib/usage/constants.ts`) and transmits the resulting **label**.
`/nbfc/applications/PL-2291/documents?tab=kyc` leaves the tab as the four letters
`nbfc`. The path is never sent, and there is no column that could store it.

`module_usage_daily` is **aggregate by construction — it has no `user_id` column**,
so it cannot answer "which modules does this person use" even for someone with
direct database access. That is why per-module usage needs none of the machinery
the login history carries: no read-audit, no row cap, no expiry.

Two consequences to know before reading the table:

- **It does not narrow when you filter to one person.** The page says so. There is
  no user id to filter on.
- **`role_bucket` is `internal` | `external`, never the role.** There is exactly
  one `ceo`, so `(day, 'nbfc', 'ceo', sessions=1)` would be a per-person row
  wearing an aggregate's name. Two permanently-crowded buckets cannot degrade that
  way as the org changes. If a per-role breakdown is ever genuinely needed, add a
  minimum cohort size enforced in SQL — do not widen the column.

`module_visit_keys` holds `md5(session_id, module, day)` so `sessions` can count
distinctly. **Do not describe it as anonymised.** `user_activity_sessions` maps
session ids to people for 30 days, so anyone who can read that table can recompute
these hashes; the protection is the 2-day prune bounding the join window, not the
hash. It is deduplication that declines to make re-identification convenient.

Externals (`dealer`, `scrap_vendor`, `nbfc_partner`) are **excluded** from
`user_activity_sessions` and **included** in `module_usage_daily`. The asymmetry is
deliberate: session-timing a business partner is a different product under a
different consent basis, while "are dealers using the dealer portal" is a
legitimate ops question the aggregate answers without measuring any one dealer.

### The invariant

> No per-person row is ever written to `ops_metric_samples` or
> `ops_daily_snapshots`.

The permanent record is aggregate-only; the per-person record expires on the
schedule above. This is what `src/lib/operations/collectors/team.ts` always
argued for, and it still holds — the *scope* of measurement moved into
purpose-built tables, the *principle* did not.

`src/lib/operations/__tests__/usageSamples.test.ts` enforces this: every sample
carries the single source `usage:all`, no source or key may contain a UUID, no
sample may carry a `meta`/`value_text` payload, and every emitted key must be
declared in the registry. If that test starts failing, something has crossed the
line.

> The shaping lives in `src/lib/operations/usageSamples.ts` rather than in the
> collector for exactly this reason — the collector imports `@/lib/db`, which
> throws at import time without `DATABASE_URL`, so an invariant expressed only
> inside it could never be tested. This documentation previously claimed such a
> test existed when it did not.

### Who can read it

The `operations` role only, via `USAGE_ANALYTICS_ROLES` in
`src/lib/operations/route-guard.ts` — a **separate set** from `OPERATIONS_ROLES`
even though the members are identical today, so that widening console access does
not silently widen access to per-employee history. `ceo` is redirected to `/ceo`.
Reading the per-person view writes an `audit_logs` row (`usage_analytics` / `view`),
from the page and from `GET /api/operations/usage` alike — the trail is not
avoidable by using curl instead of a click. `entity_id` is the person inspected,
or `all` for the unfiltered list, and rows are deduped per **(viewer, person)**
per hour rather than per viewer: the 60-second auto-refresh cannot bury the
trail, and inspecting two colleagues in one hour records both. The watchers are
watched, and this is deliberately **not** gated by `USAGE_TRACKING` — see below.

### Kill switch

`USAGE_TRACKING=0` stops every write immediately, no deploy needed. The dashboard
keeps rendering whatever was already collected.

It stops recording **employees**. It does not stop recording **who reads employee
data** — the read-audit above stays on regardless, because a period when
collection is disabled is exactly when you would want to know who was still
reading the archive.

There are three switches, nested rather than parallel, so "one switch stops
everything" stays true:

| Variable | Default | Stops |
| --- | --- | --- |
| `USAGE_TRACKING=0` | on | **everything** — logins, sessions, modules |
| `USAGE_HEARTBEAT=1` | **off** | sessions *and* per-module usage (server-side writes) |
| `NEXT_PUBLIC_USAGE_HEARTBEAT=1` | **off** | the browser timer itself; needs a rebuild |

The two heartbeat flags default **off** and are tested with `=== "1"`, the inverse
of `USAGE_TRACKING`'s `!== "0"`. The asymmetry is deliberate: login tracking is
already live so turning it *off* is the emergency action, while anything that
measures people continuously must never start recording merely because a deploy
shipped. Recommended launch posture is the client flag on and the server flag off
— the code is live and exercised, nothing is written, and enabling it later is an
env change rather than a rebuild.

### Retention is enforced by the daily rollup

`runDailySnapshot()` (`src/lib/operations/daily.ts`) deletes expired rows on the
same tick that writes the day's aggregates. The three prunes are individually
guarded against a missing table, so an environment without E-214 or E-215 applied
skips them and still prunes `ops_metric_samples` — an unguarded throw here would
have turned a schema gap into unbounded disk growth, silently. Any other error is
re-thrown: failing to delete expired personal data must be loud. Counts land in
the ticker log line (`sessions`, `login events`, `module keys`).

`module_visit_keys` is pruned at **2 days, not 1**: the prune runs on an IST day
boundary and a session still pinging across midnight must not have its key deleted
underneath it, or the next ping looks like a first visit and double-counts that
session. It also compares against an IST date rather than `NOW()`, since the keys
are written under an IST day and a UTC comparison would shift the edge by 5h30.

### Two numbers that look like they should match, and should not

`/operations/team` reports active users from Supabase's `auth.users.last_sign_in_at`
— sign-in **recency**, which includes people whose token still refreshes but who
have not opened the CRM in weeks. `/operations/usage` counts **observed sessions**.
Usage will read lower. Both pages label which is which; do not "fix" one to match
the other.

Likewise `usage.logins_24h` counts **credential entries**, not visits. Because
Supabase refresh tokens keep a session alive for days, somebody who signed in on
Monday works all week without appearing again. It will be far smaller than DAU.
That is correct.

### Staff notice — send before the heartbeat ships

Phase 1 (login events) records nothing beyond what Supabase's `last_sign_in_at`
already holds and what `/operations/team` already surfaces. **Phase 2 (the session
heartbeat) must not ship until the notice below has gone to all CRM users.** That
is the literal content of "not one you can quietly opt into on the tech team's
dashboard", and honouring it is what makes the whole thing legitimate rather than
a bypass.

> **Subject: A note on CRM usage measurement**
>
> To help us plan licences, capacity and support, the CRM now records:
> when you sign in; the start and last-active time of each CRM session; a count of
> activity pings taken every 5 minutes while the CRM tab is in the foreground; and
> your role at the time.
>
> It does **not** record the pages you visit, the records you open, anything you
> search for or type, your IP address, or your browser or device.
>
> Sign-in records are deleted after 90 days and session records after 30 days.
> Only day-level totals are kept beyond that.
>
> Access is limited to the `operations` monitoring login. Opening the per-person
> view is itself logged. Leadership sees aggregate trends.
>
> Questions go to the tech team.
