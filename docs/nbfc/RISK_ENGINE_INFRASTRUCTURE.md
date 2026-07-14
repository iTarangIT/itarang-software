# The Risk Engine — Infrastructure & Runtime View

**Companion to:** [`RISK_ENGINE_SYSTEM_DESIGN.md`](./RISK_ENGINE_SYSTEM_DESIGN.md)
**Written:** 2026-07-10
**Scope:** the *machines and processes* the Risk page depends on — where telemetry comes from, who
computes what, and which of those pieces is actually running today.

> The design doc explains **what a risk card means**. This one explains **what has to be switched on
> for a card to have a real number in it.** Read this first if the Risk page is showing an amber
> banner, or if every AI card says "Inconclusive".

---

## Table of contents

1. [The one-sentence idea](#1-the-one-sentence-idea)
2. [The diagram](#2-the-diagram)
3. [Every component, in plain English](#3-every-component-in-plain-english)
4. [The two arrows worth staring at](#4-the-two-arrows-worth-staring-at)
5. [Reality check — which boxes actually run](#5-reality-check--which-boxes-actually-run)
6. [What breaks when each box is down](#6-what-breaks-when-each-box-is-down)
7. [Known drift between the docs and reality](#7-known-drift-between-the-docs-and-reality)
8. [Runbook — getting a working local setup](#8-runbook--getting-a-working-local-setup)
9. [The analogy](#9-the-analogy)

---

## 1. The one-sentence idea

The system has **two brains that know nothing about each other**:

- The **VPS** knows what every vehicle is *doing* — where it is, how charged the battery is, how far
  it drove yesterday.
- **AWS RDS** knows what every borrower *owes* — EMI amount, days past due, outstanding principal.

Everything in this document exists to marry those two halves. The only thing that links them is the
vehicle registration number, **`vehicleno`**. There is no foreign key, no shared transaction, no
single database. A risk card is, fundamentally, a sentence that combines one fact from each brain:
*"this borrower is 9 days late (RDS) **and** their van hasn't moved in a week (VPS)."*

---

## 2. The diagram

```
                Intellicar API
                      │
                      ▼
                 ┌─────────┐
                 │ poller  │  Python · ingest every 30s
                 └────┬────┘
                      ▼
        ┌──────────────────────────────┐
        │ postgres (TimescaleDB)       │
        │  ├── raw IoT tables          │
        │  ├── continuous aggregates   │ ← Timescale auto-refresh
        │  └── dashboard_* tables      │ ← aggregator writes here
        │ + redis (poller cache)       │
        └────────┬─────────────────▲───┘
                 │                 │ writes joined results
                 ▼                 │
        ┌────────────────┐  ┌──────┴────────┐
        │ risk-sandbox   │  │ aggregator    │
        │ FastAPI        │  │ Python cron   │ ◄─── AWS RDS (NBFC loans)
        │ on-demand ML   │  └───────────────┘
        └────────┬───────┘         ▲
                 │                 │
                 └─────────┬───────┘
                           ▼
                  ┌─────────────────────┐
                  │ Next.js CRM         │  reads dashboard_* via IoT bridge,
                  │ (owns IoT views)    │  calls risk-sandbox for on-demand runs
                  └─────────────────────┘
```

The same picture, with the two-brain boundary drawn explicitly and dead paths marked:

```mermaid
graph TB
    API["Intellicar API<br/><i>third party — not ours</i>"]

    subgraph VPS["🖥️ VPS — the 'what is the vehicle doing' brain"]
        POLL["poller<br/>Python · every 30s"]
        REDIS[("redis<br/>poller cache")]
        subgraph PG["postgres + TimescaleDB"]
            RAW[("raw IoT tables<br/>vehicle_state · telemetry_gps<br/>telemetry_battery · telemetry_can · alerts")]
            CAGG[("continuous aggregates<br/>distance_rollup<br/><i>Timescale auto-refreshes</i>")]
            DASH[("dashboard_* tables<br/>dashboard_nbfc_loans_with_iot<br/>battery_health_metrics · geofence_events<br/>charge_events · fault_codes · immobilizer_state")]
        end
        AGG["aggregator<br/>Python cron"]
        SBX["risk-sandbox<br/>FastAPI · on-demand<br/>runs LLM-authored Python"]
    end

    subgraph AWS["☁️ AWS RDS — the 'what does the borrower owe' brain"]
        RDS[("nbfc_loans · loan_sanctions<br/>emi_schedules<br/>risk_hypotheses · risk_card_runs")]
    end

    APP["Next.js CRM<br/>owns all IoT views<br/>/nbfc/risk · /nbfc/batteries"]

    API --> POLL
    POLL <--> REDIS
    POLL --> RAW
    RAW -. "auto" .-> CAGG
    RDS ==>|"reads the loan book<br/>ONCE PER NIGHT"| AGG
    RAW --> AGG
    AGG -->|"writes joined results"| DASH

    RAW --> APP
    CAGG --> APP
    DASH -. "❌ CRM reads these<br/>directly, not via dashboard_*" .-> APP
    APP <-->|"{code + data} → {verdict}"| SBX
    APP <--> RDS

    style VPS fill:#fef3c7,stroke:#d97706
    style AWS fill:#dbeafe,stroke:#2563eb
    style AGG fill:#fee2e2,stroke:#dc2626
    style SBX fill:#fee2e2,stroke:#dc2626
    style DASH fill:#fee2e2,stroke:#dc2626
```

Red boxes are the ones that **do not currently run**. See §5.

---

## 3. Every component, in plain English

### Intellicar API

Intellicar is the company that makes the IoT trackers bolted onto the e-rickshaws and e-loaders.
They don't hand you the devices' raw radio signal — they give you a web API. This is the outside
world, the source of every fact about a vehicle. **You don't control it.** If Intellicar has an
outage, nothing downstream can invent the missing data.

### poller — Python, every 30 seconds

"Poll" means *ask, repeatedly*. The API will not push data to you, so a small Python program wakes
every 30 seconds, asks Intellicar "what's new?", and writes down the answer.

Two things to understand about it:

- **Nothing else in the system talks to Intellicar.** Every number you will ever see on a risk card
  entered the building through this one door.
- **If the poller stops, you get no error.** Everything downstream keeps working — it just quietly
  serves older and older data. A stopped poller looks exactly like a fleet of parked vehicles. This
  is the single most dangerous silent failure in the stack, and it is why the `dpd-7-no-telemetry`
  risk card ("vehicle has gone GPS-silent") cannot distinguish *"the borrower unplugged the tracker"*
  from *"our poller died"*.

### postgres (TimescaleDB)

Postgres is the database. **TimescaleDB** is an add-on that makes Postgres good at *time-series*
data — millions of rows that each say "at this instant, this vehicle had this value". Plain Postgres
degrades badly at that shape; Timescale transparently chops the table into time-sliced chunks (called
*hypertables*) so a query like `WHERE time > last week` doesn't scan five years of history.

That's all it is: **Postgres with a time superpower.** No new query language, no new client.

It holds three layers, and the difference between them is where most confusion lives:

#### Layer 1 — raw IoT tables

Exactly what the poller wrote, untouched. Facts, no opinions.

| Table | One row per | Notes |
|---|---|---|
| `telemetry_gps` | GPS packet | lat, lon, speed, ignition |
| `telemetry_battery` | battery packet | `soc_pct`, `soh_pct`, pack voltage |
| `telemetry_can` | CAN-bus packet | a `jsonb` `payload` blob; SOH and BMS alarm flags live in here |
| `vehicle_state` | **vehicle** | *overwritten*, not appended — always the latest known state of each van |
| `alerts` | alert | `resolved_at IS NULL` = still open |

`vehicle_state` is the odd one out and worth internalising: it is a *current-state* table, not a
history table. It answers "where is this van **now**", never "where was it on Tuesday".

#### Layer 2 — continuous aggregates

Pre-computed summaries that **Timescale refreshes by itself**. Nobody schedules them and no cron job
owns them. You declare once — "keep a daily kilometre total per vehicle" — and Timescale keeps it
current as new rows land.

The one your CRM actually depends on is **`distance_rollup`** (`bucket_size = 'day'`).

The point is speed. Summing 14 days of GPS points for 500 vehicles on every page load would be
painful; reading 14 pre-summed rows is instant. Both the `usage-drop-7d` and
`low-utilization-active-loan` risk cards live or die on this table.

#### Layer 3 — `dashboard_*` tables

The **joined** view — e.g. `dashboard_nbfc_loans_with_iot`. These are the only tables in the VPS
database that know a *loan* exists.

**Timescale does not maintain these.** The aggregator does. That distinction is the whole reason the
next two boxes exist.

### redis (poller cache)

Redis is a tiny, extremely fast in-memory store. "Cache" here means **scratch paper**, not a
database. The poller uses it to remember things like *which packet did I last see for this vehicle*,
so it doesn't re-fetch and re-insert identical data every 30 seconds.

If Redis were wiped, **nothing is permanently lost** — the poller just does some redundant work for a
cycle. Do not put anything in Redis you would miss.

> Note: the CRM has its *own, separate* Redis (Upstash) for the BullMQ call-worker queue. Same
> technology, unrelated instance, different purpose. Don't confuse the two.

### aggregator — Python cron

A **cron** job is a program that runs on a fixed schedule (say 02:00 every night) rather than on
demand.

This is the one box with an arrow coming *in from AWS RDS*, and that arrow is its entire reason for
existing. Each night it:

1. reads the **loan book** out of the CRM's AWS database,
2. reads **telemetry** out of the VPS database,
3. stitches them together on `vehicleno`,
4. writes the result back into the VPS as the `dashboard_*` tables.

It also precomputes things too expensive to derive per-request:

| Table it fills | What it holds |
|---|---|
| `battery_health_metrics` | daily SOH, 30-day degradation rate, predicted end-of-life date |
| `geofence_events` | enter / exit / violation log per vehicle |
| `charge_events` | one row per charging session |
| `fault_codes` | open BMS diagnostic trouble codes |
| `immobilizer_state` | device-confirmed immobiliser on/off |

**Note the direction: `AWS RDS → aggregator`, never the reverse.** The aggregator *reads* your loans.
It never writes to them. Loan data flows into the VPS; it never flows back out as an authoritative
value.

### risk-sandbox — FastAPI, on-demand

**FastAPI** is a Python framework for building small web services. **"On-demand"** means that, unlike
the aggregator, it runs only when someone asks — it has no schedule.

Its job is to **execute code that an AI wrote.**

When a user clicks *Re-run analysis* on `/nbfc/risk`, an LLM produces a Python function:

```python
def evaluate(loans, vehicle_states, daily_km):
    # ...pandas...
    return {"severity": "high", "affected_count": 5, "total_count": 5,
            "finding_summary": "...", "evidence": {...}}
```

The CRM will **not** run that inside its own process. Model-authored code goes into a locked box:

- no filesystem, no network, no `exec` / `eval`
- only `pandas` and `numpy` importable
- a 30-second kill switch (the CRM caps its own wait at 35 s — `risk-sandbox-client.ts`)
- **no database connection of its own** — the CRM ships the DataFrames *with* the request

It answers with a verdict and forgets everything. Stateless by design.

> ⚠️ The label **"on-demand ML"** on the diagram overstates it. There is **no trained model** here.
> It is an arbitrary-Python executor. Nothing is learned, nothing is fitted, nothing is scored by a
> classifier. Calling it ML sets the wrong expectation with anyone reading the architecture.

### Next.js CRM

Your application. Three responsibilities in this picture:

1. **Reads the VPS** through a read-only account (`dashboard_ro`) — `SELECT` permission and nothing
   else, so the CRM *physically cannot* corrupt telemetry. This is the right design. (See §7 — it is
   not what your local `.env.local` actually does.)
2. **Owns all IoT views.** "Owns IoT views" on the diagram means the *presentation* of telemetry —
   Battery Monitoring, the Risk page, the fleet map — lives in Next.js, not on the VPS. The VPS
   serves rows; it renders nothing.
3. **Is the only caller of the risk-sandbox.**

All of the VPS SQL is confined to exactly one file: `src/lib/db/iot-queries.ts`. The connection lives
in `src/lib/db/iot.ts`. Nothing else in the codebase may open a socket to the VPS.

---

## 4. The two arrows worth staring at

### CRM ⇄ risk-sandbox (bidirectional, request/response)

```
CRM  ──►  POST /execute  { hypothesis_slug, code, data: { loans, vehicle_states, daily_km } }
CRM  ◄──  { ok, result: { severity, affected_count, total_count, evidence }, elapsed_ms }
```

The CRM ships the **data alongside the code**. The sandbox never queries anything. That is what makes
it safe to hand it code an LLM wrote thirty seconds ago: even a malicious `evaluate()` has nothing to
reach for.

### AWS RDS ──► aggregator (one-way, once per night)

This is the **only** arrow in the diagram that crosses the two-brain boundary on a schedule.
Everything else is confined to one side or the other. If you are ever debugging "why does the VPS
think this loan is closed", the answer is always: *because that's what RDS said at 02:00.*

---

## 5. Reality check — which boxes actually run

This is where the diagram and reality part ways. Verified 2026-07-10.

| Box | Status | How I know |
|---|---|---|
| Intellicar API | ✅ live | poller is writing |
| poller → raw tables | ✅ running | `vehicle_state` and `distance_rollup` return live rows |
| Timescale continuous aggregates | ✅ running | `distance_rollup` (`bucket_size='day'`) is populated; it's what `getDailyKm()` reads |
| redis | ✅ assumed | poller-internal; not observable from the CRM |
| **aggregator** | ❌ **never ran** | `aggregator_runs` is empty and `daily_distance_per_vehicle` has zero rows — documented at `src/lib/db/iot-queries.ts:216` |
| **`dashboard_*` tables** | ❌ **not read by the CRM** | nothing in `src/` selects from a `dashboard_*` table; the only `dashboard_` string in the codebase is the *role name* `dashboard_ro` |
| **risk-sandbox** | ❌ **not configured** | `GET /api/health` → `sandbox: {ok: false, error: "NBFC_SANDBOX_URL not set"}` |
| IoT bridge (SSH tunnel) | ⚠️ **down at time of writing** | `127.0.0.1:5500` refused on IPv4, IPv6 and `localhost` |

### The tables the CRM *actually* reads on the VPS

Counted from `iot-queries.ts`:

```
vehicle_state            ← raw          (3 queries)
telemetry_can            ← raw          (3 queries)
alerts                   ← raw          (2 queries)
telemetry_gps            ← raw          (1)
telemetry_battery        ← raw          (1)
distance_rollup          ← cont. agg    (1)
battery_health_metrics   ← aggregator   (1, WITH FALLBACK)
geofence_events          ← aggregator   (1, WITH FALLBACK)
immobilizer_state        ← aggregator   (1, WITH FALLBACK)
charge_events            ← aggregator   (1, WITH FALLBACK)
fault_codes              ← aggregator   (1, WITH FALLBACK)
dashboard_*              ← NEVER
```

---

## 6. What breaks when each box is down

### The aggregator never ran → the CRM grew fallbacks for everything it should have filled

Because the aggregator's tables are empty or absent, **`iot-queries.ts` had to learn to do the
aggregator's job live, on every request.**

- `getBatteryHealth()` tries `battery_health_metrics`, finds nothing, then calls
  `deriveBatteryHealthFromTelemetry()` — recomputing SOH slope and end-of-life projection from raw
  `telemetry_battery` on the spot.
- `getGeofenceEvents()` falls back to `deriveGeofenceEventsFromGps()` — which re-derives the
  borrower's "home" location by binning GPS points into 0.1° cells and taking the most-visited one,
  then walks the whole track looking for boundary crossings.
- `getOpenFaultCodes()` falls back to `deriveOpenFaultsFromCan()` — scanning 24 h of CAN packets for
  `*_alarm` / `*_protection` flags.
- `getImmobilizerState()` falls back to the CRM's own `nbfc_immobilisation_actions` command log.

That is why `iot-queries.ts` is 985 lines. **Roughly half of it is compensating for one box on this
diagram that does not exist.**

It also caused a real, shipped bug: the `low-utilization-active-loan` risk card originally read
`daily_distance_per_vehicle` (an aggregator table). That table is empty, so every vehicle reported
zero km, so the card fired a false **"N of N vehicles idle"** High Alert. The fix was to repoint it
at `distance_rollup` — a Timescale-maintained continuous aggregate that needs no aggregator. See the
comment at `iot-queries.ts:216`.

> **Lesson.** A continuous aggregate refreshes itself. An aggregator table needs a process someone
> remembered to start. Prefer the former.

### The sandbox isn't configured → the Risk page grades itself on vibes

`sandboxHealthy()` is probed once per run. When it fails, `run_test` silently falls back to asking
`gpt-4o-mini` to **state** the severity and the counts rather than compute them. Those model-invented
numbers land in the same `risk_card_runs` columns and render in the same red chip as the
hand-computed ones. The only trace is `llm_critique` — which is stored and never displayed.

This is the highest-priority defect in
[`RISK_ENGINE_SYSTEM_DESIGN.md` §10.9](./RISK_ENGINE_SYSTEM_DESIGN.md#-high) and the fix is Phase 4,
item 16: *never let the LLM choose severity; if the sandbox is down, the card is `inconclusive`, not
`ok`.*

### The tunnel is down → amber banner

Every hand-coded evaluator throws, `loadCards()` catches per-hypothesis, and the Risk page renders
*"IoT VPS unreachable — some risk cards unavailable."* Battery Monitoring goes blank the same way.

---

## 7. Known drift between the docs and reality

Three discrepancies worth fixing, in descending order of how much they'd hurt.

**7.1 — The connection string in the code comment is not the connection string in use.**

| | |
|---|---|
| `src/lib/db/iot.ts:9` claims | `postgres://dashboard_ro:<pw>@<vps-ip>:5433/intellicar?sslmode=require` |
| `.env.local` actually has | `postgres://itarang_admin:***@127.0.0.1:5500/itarang?sslmode=require` |

Different **user**, **port**, **host** and **database name**. The one that matters is the user: the
whole "the CRM physically cannot corrupt telemetry" guarantee rests on connecting as `dashboard_ro`
with `SELECT`-only grants. Locally, we connect as **`itarang_admin`**. The safety property described
in the doc-block is not in force. Nothing in `iot-queries.ts` writes today, so no damage has been
done — but the guardrail is a comment, not a permission.

**7.2 — `dashboard_*` is on the diagram and in no query.**

The diagram's caption says the CRM "reads `dashboard_*` via IoT bridge". It does not. It reads raw
tables and `distance_rollup` directly, and reaches for the aggregator's five side tables with a
fallback each. Either build the aggregator or redraw the box.

**7.3 — "on-demand ML" is not ML.** See §3. Rename it to *sandboxed Python executor* before somebody
budgets for a data scientist.

---

## 8. Runbook — getting a working local setup

For any risk card to show a real number, you need, in order:

```bash
# 1. The IoT tunnel. Without this, every hand-coded card throws and you get the amber banner.
#    Port 5500 → itarang-iot-db RDS. (NOT the dead 5433/intellicar tunnel the docs describe.)
ssh -N iot-bastion

# 2. Verify. All three deps should report ok:true.
curl -s localhost:3000/api/health | jq .deps
#   crm_db     → the AWS RDS the CRM owns
#   iot_bridge → the tunnel above
#   sandbox    → NBFC_SANDBOX_URL

# 3. (Optional) The Python sandbox, if you want AI cards graded on arithmetic
#    rather than on a language model's opinion.
export NBFC_SANDBOX_URL=http://127.0.0.1:8091
```

Env vars that govern this stack:

| Var | Default | What happens if it's missing |
|---|---|---|
| `DATABASE_URL` | — | nothing works |
| `IOT_DATABASE_URL` | — | every hand-coded card throws → amber banner |
| `OPENAI_API_KEY` | — | "Re-run analysis" throws immediately |
| `NBFC_OPENAI_MODEL` | `gpt-4o-mini` | — |
| `NBFC_SANDBOX_URL` | `http://127.0.0.1:8091` | falls back to LLM-invented verdicts, **silently** |

Diagnosing which brain is at fault:

```
Card shows a number, and it's wrong ......... the evaluator's logic  → RISK_ENGINE_SYSTEM_DESIGN.md §8
Card shows "IoT VPS unreachable" ............ the tunnel             → ssh -N iot-bastion
Card shows "Inconclusive" / "Sandbox error"   the sandbox            → NBFC_SANDBOX_URL
Card shows 0 affected out of 0 total ........ no telemetry rows      → the poller, or vehicleno mismatch
Every AI card is green "OK" ................. failures rendering as OK → §10.1 of the design doc
```

---

## 9. The analogy

The **poller** is a security guard writing every event in a logbook, once every 30 seconds, forever.

**Timescale's continuous aggregates** are the daily totals he tallies at the bottom of each page,
automatically, without being asked.

The **aggregator** is the night-shift accountant who takes the logbook, fetches the loan ledger from
a different building, and writes a combined report — except this accountant was hired and never
showed up, so every morning the analysts re-do his arithmetic by hand. (That hand-arithmetic is the
fallback half of `iot-queries.ts`.)

The **risk-sandbox** is a soundproof room where you let an intern run an experiment on a photocopy of
the data, because you don't trust him near the originals. Right now the room hasn't been built, so
the intern is just *telling you what he reckons the answer is* — and you're writing it down as if he'd
measured it.

The **Next.js CRM** is the front desk everyone actually talks to.

---

## Appendix — the shortest possible mental model

```
   Intellicar  ──30s──►  poller  ──►  raw tables ──auto──► distance_rollup
                                          │                      │
                                          └──────────┬───────────┘
                                                     │  vehicleno
                              nbfc_loans  ───────────┤
                              (AWS RDS)              │
                                                     ▼
                                          ┌─────────────────────┐
                                          │  A TEST             │
                                          │  TS evaluator, or   │
                                          │  Python in sandbox, │
                                          │  or (today) the     │
                                          │  LLM's opinion      │
                                          └──────────┬──────────┘
                                                     ▼
                                             risk_card_runs
                                                     ▼
                                                 A CARD
```

Two things worth remembering: **the vehicleno join is the only thing holding the two halves
together**, and **every box on this diagram that requires a human to have started a process is not
running.**
