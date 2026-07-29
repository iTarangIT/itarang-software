# Intellicar Dashboard — APIs and What We Store

Every API involved in `/ceo/intellicar`, the JSON each one returns, and the database column
each value ends up in.

There are **two API layers**, and confusing them is the most common mistake made about this
system:

| | Layer 1 — vendor | Layer 2 — CRM |
|---|---|---|
| Who serves it | Intellicar (`apiplatform.intellicar.in`) | This Next.js app |
| Who calls it | the `iot_stack` Python poller on AWS | the dashboard's React tabs |
| When | continuously, in the background | on every page view |
| Writes to the DB? | **yes** — this is the only writer of telemetry | **no** — read-only |

**The CRM never calls Intellicar at request time.** `src/lib/intellicar/client.ts` wraps six
vendor endpoints but has **zero importers** — it is unused code kept for reference. Every number
on the dashboard is read out of Postgres, which the poller filled minutes-to-hours earlier.

Companion documents — this one owns the **transport contract**, they own the rest:

- [`intellicar-calculations.md`](./intellicar-calculations.md) — the maths behind every derived
  number. Source of truth for derivations; referenced below as `§n` rather than restated.
- [`intellicar-ceo-dashboard-cards.md`](./intellicar-ceo-dashboard-cards.md) — what each card on
  screen means.
- [`why-30-second-vehicle-data-explained.md`](./why-30-second-vehicle-data-explained.md) — the
  plain-English account of why the stored feed was not 30 s and what was changed in the poller.

---

## Table of contents

- [0. The pipeline](#0-the-pipeline)
- [1. Layer 1 — the Intellicar vendor API](#1-layer-1--the-intellicar-vendor-api)
- [2. What lands in the database](#2-what-lands-in-the-database)
- [3. Layer 2 — the CRM dashboard endpoints](#3-layer-2--the-crm-dashboard-endpoints)
- [4. The shared analytics query contract](#4-the-shared-analytics-query-contract)
- [5. Appendix](#5-appendix)

---

# 0. The pipeline

```
┌──────────────────────────┐
│  Battery / BMS / tracker │  streams CAN + GPS, ~30 s
└────────────┬─────────────┘
             ▼
┌──────────────────────────┐
│  Intellicar cloud        │  apiplatform.intellicar.in/api/standard
│  (LAYER 1 — vendor API)  │  gettoken, getlatestcan, getbatterymetricshistory, …
└────────────┬─────────────┘
             │  POST, bearer token
             ▼
┌──────────────────────────┐
│  iot_stack poller        │  repo iTarangIT/iot_stack, Docker on AWS, /opt/intellicar
│  (poll.py)               │  THE ONLY WRITER of telemetry
└────────────┬─────────────┘
             │  INSERT
             ▼
┌──────────────────────────┐        ┌───────────────────────────┐
│  IoT Postgres            │        │  CRM Postgres (AWS RDS)   │
│  vehicle_state           │        │  device_battery_map       │
│  telemetry_can           │        │  battery_spec_models      │
│  telemetry_battery       │        │  app_settings             │
│  telemetry_gps           │        │  (Drizzle, read + write)  │
│  distance_rollup         │        └─────────────┬─────────────┘
│  trips, alerts, vehicles │                      │
│  (read-only, getIotSql)  │                      │
└────────────┬─────────────┘                      │
             │                                    │
             └──────────────┬─────────────────────┘
                            ▼
              ┌──────────────────────────┐
              │  /api/telemetry/*        │  LAYER 2 — this repo
              │  (LAYER 2 — CRM API)     │  src/app/api/telemetry/**/route.ts
              └────────────┬─────────────┘
                           ▼
              ┌──────────────────────────┐
              │  /ceo/intellicar — 7 tabs│
              └──────────────────────────┘
```

**The two databases are not federated.** Every cross-database join (VPS telemetry enriched with
CRM dealer/customer data) happens in the Node process — see `fetchAlerts`, `fetchWarrantyRisk`,
`fetchVehicleActivity` in `src/lib/telemetry/queries.ts`.

Connections:

| DB | Client | Env var | Access |
|---|---|---|---|
| IoT Postgres | `getIotSql()` — `src/lib/db/iot.ts` | `IOT_DATABASE_URL` | `SELECT` only (role `dashboard_ro`); the one exception is `UPDATE alerts SET resolved_at` |
| CRM RDS | `db` (Drizzle) — `src/lib/db/index.ts` | `DATABASE_URL` | read + write |

---

# 1. Layer 1 — the Intellicar vendor API

Base URL: `https://apiplatform.intellicar.in/api/standard`
Auth: bearer token from `POST /gettoken`, cached 55 minutes client-side.
Transport: **every endpoint is `POST`**, including the read ones.

> **Accuracy note.** The request bodies below are verified from
> `src/lib/intellicar/client.ts`. The **response** shapes are reconstructed from the columns the
> poller writes, because the poller lives in the separate `iTarangIT/iot_stack` repo and its
> HTTP transcripts are not in this tree. The one response we can verify exactly is
> `getlatestcan` — its payload is stored verbatim as JSONB and our SQL reads named keys out of
> it, so those key names are facts, not guesses. Everything else is marked *(inferred)*.

## 1.1 `POST /gettoken`

Authenticate. Called once per 55 minutes.

**Request**

```json
{ "username": "<INTELLICAR_USERNAME>", "password": "<INTELLICAR_PASSWORD>" }
```

**Response**

```json
{ "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…" }
```

| Field | Type | Notes |
|---|---|---|
| `token` | string | Bearer token. The client also accepts `accessToken` as an alias — whichever is present is used (`client.ts:24`). |

**Stored:** nothing. Held in memory only, `expiresAt = now + 55 min`.

## 1.2 `POST /listvehicledevicemapping`

The fleet roster — which tracker device is fitted to which vehicle.

**Request**

```json
{}
```

**Response** *(inferred)*

```json
{
  "data": [
    {
      "vehicleno": "TK-51105-02AZ-179422",
      "deviceid": "IC-8829471",
      "makemodel": "iTarang L3 Passenger",
      "owner": ""
    }
  ]
}
```

| Field | Type | Stored as |
|---|---|---|
| `vehicleno` | string | `vehicles.vehicleno` — **the join key for the whole system**. Every telemetry table is keyed by it; the CRM's `device_battery_map.vehicle_number` matches on it. |
| `deviceid` | string | The vendor's device handle. Used by the poller for subsequent calls; the CRM never sees it. |
| `makemodel` | string | `vehicles.makemodel` — surfaced as `vehicle_type` / `customer_name` on the fleet map. |
| `owner` | string | `vehicles.owner`. **Blank across this entire fleet**, which is why customer names come from the CRM's `device_battery_map` instead. |

## 1.3 `POST /getlatestcan`

The latest decoded CAN frame for one device — SOC, current, voltage, nameplate capacity. This
is the highest-frequency call the poller makes and the origin of most dashboard numbers.

**Request**

```json
{ "deviceid": "IC-8829471" }
```

**Response** — key names **verified** (our SQL reads them directly)

```json
{
  "data": {
    "timestamp": "2026-07-24T09:14:32.000Z",
    "soc":              { "value": 78.0,  "unit": "%"  },
    "current":          { "value": 21.4,  "unit": "A"  },
    "battery_voltage":  { "value": 56.8,  "unit": "V"  },
    "rated_capacity":   { "value": 105.0, "unit": "Ah" }
  }
}
```

| Field | Type | Read by the CRM as | Notes |
|---|---|---|---|
| `soc.value` | float | `payload->'soc'->>'value'` | State of charge, 0–100. **Rising SOC is the only charging signal we have.** |
| `current.value` | float | `payload->'current'->>'value'` | Pack current, amps — **unsigned magnitude**. It cannot tell you charge from discharge. Discharge (~57 A) runs *higher* than charge (~21 A). See §1 of the calculations doc. |
| `battery_voltage.value` | float | `payload->'battery_voltage'->>'value'` | Pack volts. |
| `rated_capacity.value` | float | `payload->'rated_capacity'->>'value'` | Nameplate Ah. A per-battery constant — read once per query as an uncorrelated scalar, not per row. Drives the capacity plausibility check. |

Readings with `abs(current) > MAX_VALID_CURRENT_A` are treated as decode faults and excluded at
query time (`src/lib/telemetry/charging-sql.ts`). A *missing* reading is not corrupt and is kept.

**Stored:** the whole object goes into `telemetry_can.payload` (JSONB) verbatim, plus
`vehicleno` and `time`. Nothing is flattened into columns — every consumer digs into the JSONB.

**Why this table is full of duplicates.** The poller's live loop calls this endpoint (and
`getlastgpsstatus`) every 30 s, but both return only the **newest cached frame** — polling them
faster than the device publishes returns the same frame repeatedly, and each repeat is inserted
again. That is the mechanism behind the duplicate-timestamp problem in §2.1, and it is why real
30 s resolution had to come from `getbatterymetricshistory` (§1.4) instead.

## 1.4 `POST /getbatterymetricshistory`

Battery history over a time range — the **true ~30 s cadence** series.

**Request**

```json
{ "deviceid": "IC-8829471", "starttime": "2026-07-24 09:00:00", "endtime": "2026-07-24 09:30:00" }
```

**Response** *(inferred)*

```json
{
  "data": [
    { "timestamp": "2026-07-24T09:00:04.000Z", "soc": 77.5, "soh": 100.0,
      "voltage": 56.6, "current": 21.1, "temperature": 34.2 },
    { "timestamp": "2026-07-24T09:00:34.000Z", "soc": 77.6, "soh": 100.0,
      "voltage": 56.7, "current": 21.3, "temperature": 34.3 }
  ]
}
```

| Field | Stored as | Notes |
|---|---|---|
| `timestamp` | `telemetry_battery.time` | |
| `soc` | `telemetry_battery.soc_pct` | |
| `soh` | `telemetry_battery.soh_pct` | Reads **exactly 100.0 on every reporting pack** — the BMS SOH feed is stuck. The dashboard detects this and withholds the SOH KPIs rather than printing a fake pass mark (`soh-math.ts`). |
| `voltage` | `telemetry_battery.pack_voltage` | |
| `current` | `telemetry_battery.pack_current` | Unsigned, same convention as CAN. |
| `temperature` | `telemetry_battery.pack_temp_c` | |

**This call is why 30 s data exists at all.** `poll_recent` in `iot_stack/poll.py` pulls battery
history every 5 minutes, so `telemetry_battery` carries near-duplicate-free 30 s samples —
unlike `telemetry_can`, which is a re-inserted live snapshot. Shipped 2026-07-20; see
[`intellicar-poller-30s-escalation.md`](./intellicar-poller-30s-escalation.md).

There is no `rated_capacity` in this response, which is why the nameplate is still read from
`telemetry_can` even when a query otherwise runs entirely on `telemetry_battery`.

## 1.5 `POST /getgpshistory`

Position history over a time range.

**Request**

```json
{ "deviceid": "IC-8829471", "starttime": "2026-07-24 09:00:00", "endtime": "2026-07-24 09:30:00" }
```

**Response** *(inferred)*

```json
{ "data": [ { "timestamp": "2026-07-24T09:00:11.000Z", "lat": 19.076090,
              "lng": 72.877426, "speed": 24.5, "heading": 118.0, "ignition": true } ] }
```

| Field | Stored as |
|---|---|
| `timestamp` | `telemetry_gps.time` |
| `lat` / `lng` | `telemetry_gps.lat` / `.lon` |
| `speed` | `telemetry_gps.speed_kph` |
| `heading` | `telemetry_gps.heading` |
| `ignition` | `telemetry_gps.ignition` |

> **This endpoint returns empty in practice.** GPS therefore cannot be had at 30 s — the poller
> falls back to the live snapshot (§1.6), so `telemetry_gps` carries snapshot-cadence fixes, not
> a true history. This is a vendor-side limitation, not a poller bug.

## 1.6 `POST /getlastgpsstatus`

The live position snapshot for one device — the actual GPS source.

**Request**

```json
{ "deviceid": "IC-8829471" }
```

**Response** *(inferred)* — same field set as one element of §1.5, current-valued.

**Stored:** a row in `telemetry_gps`, and the live columns of `vehicle_state`
(`lat`, `lon`, `speed_kph`, `last_gps_at`, `online`).

## 1.7 `POST /getdistancetravelled`

Odometer delta over a range.

**Request**

```json
{ "deviceid": "IC-8829471", "starttime": "2026-07-23 00:00:00", "endtime": "2026-07-24 00:00:00" }
```

**Response** *(inferred)*

```json
{ "data": { "distance": 41.8, "unit": "km" } }
```

**Stored:** `distance_rollup` — one row per vehicle per day (`bucket_size = 'day'`,
`distance_km`). This is **the only populated distance source in the system**; every kilometre on
the dashboard traces back to it.

---

# 2. What lands in the database

## 2.1 IoT Postgres — written by the poller, read-only to the CRM

**Measured state, 2026-07-25** (via `GET /api/system/database-monitor`) — the fleet is **317
vehicles**, and the two battery series sit like this:

| Physical table | Rows | On disk |
|---|---:|---:|
| `telemetry_can_default` | 3,232,844 | 7,152 MB |
| `telemetry_battery_default` | 17,783,940 | 2,709 MB |
| `telemetry_gps_default` | 4,744,284 | 603 MB |

`telemetry_battery` holds **5.5× more samples** than `telemetry_can` yet uses **2.6× less disk** —
the CAN table stores a whole JSONB frame per row. Note the `_default` suffix: these tables are
**partitioned**, and the monitor endpoint lists the physical partitions, while every query in the
CRM targets the parent name.

### `vehicle_state` — one live row per vehicle

The most-read table on the dashboard: all 8 Fleet Overview cards, the fleet map, the device
tables and the dealer comparison come from here.

| Column | Type | From | Meaning |
|---|---|---|---|
| `vehicleno` | text (PK) | §1.2 | Registration number; the fleet-wide join key. |
| `soc_pct` | float | §1.3 `soc.value` | Latest state of charge. |
| `soh_pct` | float | §1.4 `soh` | Latest state of health. **Constant 100.0 fleet-wide** — treat as unmeasured. |
| `pack_voltage` | float | §1.3 `battery_voltage.value` | Latest pack volts. |
| `pack_current` | float | §1.3 `current.value` | Latest pack amps, unsigned. |
| `pack_temp_c` | float | §1.4 `temperature` | Latest pack temperature. |
| `lat`, `lon` | float | §1.6 | Latest fix. |
| `speed_kph` | float | §1.6 | Latest speed. |
| `last_battery_at` | timestamptz | derived | When battery/CAN telemetry last arrived. Drives the `disconnected` status. |
| `last_gps_at` | timestamptz | derived | When a GPS fix last arrived. Drives `comm_status`. |
| `last_seen` | timestamptz | derived | Any contact. The default sort key. |
| `online` | boolean | derived | Poller's liveness verdict. Drives Utilization / Fleet Uptime. |
| `open_alert_count` | int | derived | Unresolved alerts for this vehicle. `> 0` ⇒ map status `critical`. |

### `telemetry_can` — the JSONB live-snapshot series

| Column | Type | Notes |
|---|---|---|
| `vehicleno` | text | |
| `time` | timestamptz | |
| `payload` | **jsonb** | The `getlatestcan` object, unflattened. Keys read by the CRM: `soc`, `current`, `battery_voltage`, `rated_capacity` — each with a `value` sub-key. |

**The duplicate problem.** The poller re-inserts the latest CAN frame on every poll whether or
not the device produced a new one.

**Measured 2026-07-25** on `TK-51105-09LY-171632` over a 3-month window (via
`GET analytics/cadence`): **82% of rows are duplicate timestamps**, the median gap between
*distinct* samples is **3,690 s (61 minutes)**, p90 is **3,840 s**, and only **19.2 distinct
samples per day** survive — against a device streaming every ~30 s.

> Older reviews quote 67% duplicates and a ~510 s median. Both were true when measured; **the
> cadence keeps drifting and is per-battery**. Never hardcode it — call `analytics/cadence` for
> the window and pack you are actually looking at.

Consequence: **every query must dedupe with `DISTINCT ON (time)` before doing arithmetic.**
Without it, `time − LAG(time)` is 0 across each duplicate and those samples contribute no Ah at
all. This is the root of most "lower bound" caveats on the dashboard.

### `telemetry_battery` — the true-cadence series

| Column | Type | From |
|---|---|---|
| `vehicleno`, `time` | | |
| `soc_pct`, `soh_pct` | float | §1.4 |
| `pack_voltage`, `pack_current`, `pack_temp_c` | float | §1.4 |

Near duplicate-free, ~30 s spacing. **Which series a query reads is a deliberate choice**
(`SampleSource` in `src/lib/telemetry/charging-sql.ts`):

- **Charging analysis reads `battery`** — so the Ah integral runs over the real current curve.
- **Discharge and mileage stay on `can`** — pending separate verification.
- The nameplate always comes from `can`, because `telemetry_battery` has no `rated_capacity`.

### `telemetry_gps`

| Column | Type | Notes |
|---|---|---|
| `vehicleno`, `time` | | |
| `lat`, `lon` | float | Fixes at `lat=0 AND lon=0`, or `abs(lat)>90` / `abs(lon)>180`, are rejected at query time as decode faults — one of them would stretch the map's bounding box across the Atlantic. |
| `speed_kph` | float | |
| `heading` | float | |
| `ignition` | boolean | Used by the dwell/parking clustering. |

### `distance_rollup`

| Column | Type | Notes |
|---|---|---|
| `vehicleno` | text | |
| `time` | timestamptz | Bucket start. |
| `bucket_size` | text | **Always pin `'day'`.** Other bucket sizes exist and would dilute any daily average. |
| `distance_km` | float | |

### `alerts`

| Column | Type | Notes |
|---|---|---|
| `vehicleno`, `time` | | |
| `alert_type` | text | |
| `severity` | text | |
| `message` | text | |
| `value`, `threshold` | numeric | What tripped, and against what. |
| `resolved_at` | timestamptz | NULL ⇒ open. **There is no `acknowledged_by` column** — acknowledging just stamps `resolved_at = now()`, and who did it is not recorded. |

Alert *thresholds* are hardcoded in `iot_stack/poller/poll.py`, not in any table.

### `trips` — **empty fleet-wide**

| Column | Type |
|---|---|
| `vehicleno`, `trip_id`, `time`, `end_time` | |
| `start_lat`, `start_lon`, `end_lat`, `end_lon` | float |
| `distance_km`, `duration_s`, `energy_kwh`, `avg_speed_kph` | float |

**Zero rows across the whole fleet** — the per-trip segmentation job in `iot_stack` has never
run. This is why the Fleet Activity tab reads `distance_rollup` instead, and why per-cycle
distance has to be reconstructed from GPS chords. Trip start/end points, duration and average
speed simply do not exist. Restoring them is an `iot_stack` job, not a query fix. See §15 of the
calculations doc.

### `vehicles`

`vehicleno`, `makemodel`, `owner`. `owner` is blank fleet-wide — customer names come from the CRM.

## 2.2 CRM RDS — the annotation the telemetry DB does not have

Defined in `src/lib/db/schema.ts`.

**Measured state, 2026-07-25** (`database-1…ap-south-1.rds.amazonaws.com`) — three of these
numbers explain empty responses elsewhere in this document:

| Table | Real state |
|---|---|
| `device_battery_map` | **285 rows**, all `status='active'`; **285** have `vehicle_number`; **277** have `battery_model`; **0 have `dealer_id`** |
| `battery_spec_models` | **1 row** — `LFP-51V-105AH`: 105 Ah, 44 / 60 V, 70 A, 55 °C, mileage 0.35–0.65 km/Ah |
| `app_settings` | **no `intellicar_battery_thresholds` row** — the fleet-wide override rung is empty |

Consequences, all verified rather than assumed:

- `dealer-comparison` and `fleet/dashboard.dealerPerformance` return `[]` — **zero `dealer_id`
  values**, not a telemetry failure.
- Threshold resolution looks like a no-op because the one spec model's limits **equal** the
  hardcoded defaults and there is no `app_settings` override. Only `specKeys` and the mileage
  band reveal that the spec rung fired at all.
- The 8 mappings without a `battery_model` resolve to `modelName: null` and get **no mileage
  band** on their charts.

### `device_battery_map` (`schema.ts:2443`) — the VPS↔RDS bridge

| Column | Type | Purpose |
|---|---|---|
| `id` | varchar PK | `DBM-<8 hex>` |
| `device_id` | varchar(100) | |
| `battery_serial` | varchar(100) | |
| `vehicle_number` | varchar(50) | **Matches `vehicle_state.vehicleno`** — this is the entire bridge between the two databases. |
| `vehicle_type` | varchar(50) | |
| `customer_name`, `customer_phone` | | The real customer name, since `vehicles.owner` is blank. |
| `dealer_id` | varchar(255) | Scopes the dealer portal; drives the dealer comparison. |
| `state`, `city` | text | E-184 — the Fleet Overview location filters. |
| `battery_model` | varchar(100) | E-190 — logical FK to `battery_spec_models.model_name`. |
| `status` | varchar(20) | `'active'` filters every lookup. |
| `installed_at` | timestamptz | A vehicle can appear more than once (re-deployments); the active row with the latest `installed_at` is the current pack. |

### `battery_spec_models` (`schema.ts:2467`) — per-model limits (E-190 / E-201)

`model_name` (PK), `rated_voltage_v`, `rated_capacity_ah`, `under_voltage_v`, `over_voltage_v`,
`over_current_a`, `over_temperature_c`, `min_mileage_km_per_ah`, `max_mileage_km_per_ah`, `notes`.

A NULL column means "no manufacturer limit recorded" and falls through to the fleet-wide value.

### `app_settings` (`schema.ts:2540`)

`key` (PK), `value` (jsonb). Key `intellicar_battery_thresholds` holds the fleet-wide display
threshold overrides.

## 2.3 Other consumers

`src/lib/db/iot-queries.ts` reads the same IoT tables for the **NBFC** dashboard
(`/nbfc/*`). Out of scope here; listed so a schema change is not assumed to affect only Intellicar.

---

# 3. Layer 2 — the CRM dashboard endpoints

## 3.0 The contract every endpoint shares

**Success**

```json
{ "success": true, "data": <payload> }
```

**Failure** — always with a non-200 status

```json
{ "success": false, "error": { "message": "vehicleno is required" } }
```

**Degraded** — only `fleet/dashboard` and `fleet/map`. When the IoT Postgres is unreachable
these return **HTTP 200** with zeroed data plus a banner reason, rather than a 500:

```json
{
  "success": true,
  "degraded": true,
  "reason": "IoT VPS unreachable — the SSH tunnel is down. In a terminal run: ssh -N -L 5433:127.0.0.1:5433 root@72.61.246.37, then refresh.",
  "data": { "role": "ceo", "kpis": { "fleetSize": 0, "utilization": 0, "avgSOH": null, "warrantyAtRisk": null, "activeAlerts": 0 }, "…": "…" }
}
```

Note `avgSOH` and `warrantyAtRisk` are `null`, not `0` — nothing was measured, and a `0` would
render as "no batteries at risk" on the very request that failed to ask. Reasons are classified
in `src/lib/telemetry/vps-status.ts` (not configured / ECONNREFUSED / ETIMEDOUT / ENOTFOUND).

**Provenance of the JSON below.** Blocks tagged **`CAPTURED`** are **real payloads**, taken on
**2026-07-25** from the live IoT Postgres and CRM RDS by calling the query layer directly
(harness: `scripts/_capture-intellicar-api.ts`, read-only). **All 29 endpoints captured
successfully.** Long arrays are abridged — each block says how many of how many rows it shows —
but every value shown is verbatim from the wire.

A few blocks remain tagged **`ILLUSTRATIVE`**, used only where the live fleet returns an empty
set (no deep-discharge events, no at-risk packs, no mapped dealers) and the populated shape still
needs documenting. There, field names are exact and values are representative.

The capture ran against `database-1…ap-south-1.rds.amazonaws.com` (CRM) and the IoT Postgres via
the tunnel on local port 5500. See [§5.3](#53-recapturing-these-payloads) to refresh them.

`vehicle_number` on this fleet is a **battery serial**, not a registration plate — real values look
like `TK-51105-02AZ-179422`. The examples use that format throughout.

**Client unwrapping.** Both fetch helpers return `body.data`, so the TypeScript interfaces in
`src/components/intellicar/battery/types.ts` describe the **`data` member**, not the whole body:

- `readTelemetry<T>` — `HealthAnalytics.tsx:18`
- `getJson<T>` — `BatteryAnalytics.tsx:119`

**Auth.** Every route calls `requireRole(...)` from `src/lib/auth-utils`. Roles are noted per
endpoint below. Where `['ceo','dealer']` is allowed, a `dealer` caller is silently scoped to
their own `device_battery_map.dealer_id` vehicles and **cannot** widen it with query params.

**Polling.** The Battery tab refetches the active sub-tab's queries every 30 s. The stored feed
only updates every ~8.5 min, so most refetches return identical values — polling faster than the
poller writes does not raise resolution, and the cadence readout says so.

---

## 3.1 Fleet Overview tab

### `GET /api/telemetry/fleet/locations`

Distinct State/City options for the filter dropdowns. **Reads RDS only** — no IoT DB, so there
is no degraded path.

- **Caller:** `FleetOverview.tsx:38` · **Roles:** `ceo`, `dealer` · **Params:** none

**`CAPTURED`** 2026-07-25 — abridged to 3 of 6 states; the real response carries all six and 34 cities.

```json
{
  "success": true,
  "data": {
    "states": ["Bihar", "Haryana", "Madhya Pradesh", "Punjab", "Uttar Pradesh", "Uttarakhand"],
    "citiesByState": {
      "Bihar": ["Barauli", "Gopalganj", "Kuchaikote", "Manjha", "Nautan", "Patna", "Phulwari", "Uchkagaon"],
      "Haryana": ["Gurugram", "Sonipat"],
      "Punjab": ["Jalandhar", "Jalandhar II Tahsil"]
    }
  }
}
```

The real fleet is deployed across **Bihar, Haryana, Madhya Pradesh, Punjab, Uttar Pradesh and
Uttarakhand** — **34 cities** in total: Uttar Pradesh 14, Bihar 8, Madhya Pradesh 4,
Uttarakhand 4, Haryana 2, Punjab 2.

| Field | Type | Notes |
|---|---|---|
| `states` | string[] | Sorted. Only `status='active'` rows with a non-null `state`. |
| `citiesByState` | Record<string, string[]> | Cities sorted per state. A state with no cities still appears with an empty array. |

**Reads:** `device_battery_map` (RDS).

---

### `GET /api/telemetry/fleet/dashboard`

The 8 KPI cards. Response shape **differs by role**.

- **Caller:** `FleetOverview.tsx:52` · **Roles:** `ceo`, `dealer` · **Degraded path:** yes

| Param | Type | Default | Notes |
|---|---|---|---|
| `state` | string | — | CEO only. Resolves to a vehicle-number set via RDS, then scopes every IoT query. |
| `city` | string | — | CEO only. ANDs with `state`. |

**CEO response** — **`CAPTURED`** 2026-07-25

```json
{
  "success": true,
  "data": {
    "role": "ceo",
    "kpis": { "fleetSize": 317, "utilization": 86, "avgSOH": null, "warrantyAtRisk": null, "activeAlerts": 61 },
    "sohFeed": { "assessed": 304, "unassessable": 13, "constantFeed": true, "constantValue": 100 },
    "dealerPerformance": [],
    "serviceMetrics": { "fleetUptime": 86, "avgDailyDistance": 56, "offlineDevices": 44 }
  }
}
```

The live fleet is **317 vehicles**, 86% online. `avgSOH` and `warrantyAtRisk` really do come back
`null`: 304 packs report SOH, all of them exactly 100, so `constantFeed` is true and both KPIs are
withheld. 13 packs report no SOH at all.

| Field | Type | Meaning |
|---|---|---|
| `kpis.fleetSize` | int | `count(*)` of `vehicle_state` in scope. |
| `kpis.utilization` | int | `round(online / fleetSize × 100)`. |
| `kpis.avgSOH` | float \| **null** | **null when the SOH feed is not measuring** — every pack reporting an identical value makes the average that value by construction. Never render null as 0. |
| `kpis.warrantyAtRisk` | int \| **null** | Packs with `soh_pct < 80`. Null under the same condition — "0 at-risk out of a stuck sensor" is a pass mark nobody earned. |
| `kpis.activeAlerts` | int | `alerts` with `resolved_at IS NULL`. |
| `sohFeed.assessed` | int | Packs that reported any SOH. |
| `sohFeed.unassessable` | int | Packs that reported none — **unmeasured, not healthy**. |
| `sohFeed.constantFeed` | bool | True ⇒ one distinct value across the fleet ⇒ the two SOH KPIs are withheld. |
| `sohFeed.constantValue` | float \| null | That stuck value, for the card's explanatory text. |
| `dealerPerformance[]` | array | Same rows as §3.4 `dealer-comparison`, filtered to `state`/`city`. **Verified empty on the current data** — no `device_battery_map` row has a `dealer_id`. The example above shows the populated shape. |
| `serviceMetrics.fleetUptime` | int | Same number as `utilization`. |
| `serviceMetrics.avgDailyDistance` | float | `avg(distance_km)` over `distance_rollup`, `bucket_size='day'`, last 7 days. |
| `serviceMetrics.offlineDevices` | int | `fleetSize − online`. |

**Dealer response**

```json
{ "success": true,
  "data": { "role": "dealer",
    "kpis": { "vehicleCount": 42, "avgSOC": 63.4, "faultyDevices": 0, "activeToday": 31, "energy24h": 0 } } }
```

`energy24h` is **hardcoded 0** — not computed. `activeToday` counts `last_gps_at` within 24 h.

**Reads:** `vehicle_state`, `alerts`, `distance_rollup` (IoT) + `device_battery_map` (RDS).
**Code:** `fetchFleetDashboardCEO` / `fetchFleetDashboardDealer`, `queries.ts:64`.

---

### `GET /api/telemetry/fleet/map`

One row per vehicle for the map and the Fleet Devices table.

- **Caller:** `FleetOverview.tsx:64` · **Roles:** `ceo`, `dealer` · **Degraded path:** yes (`data: []`)
- **Params:** `state`, `city` — CEO only; dealers stay scoped to their own vehicles regardless.

**`CAPTURED`** 2026-07-25 — 1 of 317 rows.

```json
{
  "success": true,
  "data": [
    { "device_id": "TK-51105-02DZ-213419", "vehicle_number": "TK-51105-02DZ-213419",
      "customer_name": null, "soc": 68, "soh": 100,
      "battery_updated_at": "2026-07-25T11:33:00.893Z",
      "latitude": 25.35783, "longitude": 81.885306,
      "gps_updated_at": "2026-07-25T11:46:30.858Z", "status": "healthy" }
  ]
}
```

`customer_name` is **null on every row** — it maps to `vehicles.makemodel`, which is unpopulated
fleet-wide (as is `vehicles.owner`). Any customer-facing name has to come from the CRM's
`device_battery_map`, which this endpoint does not join.

| Field | Type | Notes |
|---|---|---|
| `device_id`, `vehicle_number` | string | Both are `vehicleno` — duplicated for legacy UI compatibility. |
| `customer_name` | string \| null | Actually `vehicles.makemodel`, despite the name. |
| `soc`, `soh` | float \| null | |
| `battery_updated_at` | ISO ts \| null | `last_battery_at`. |
| `latitude`, `longitude` | float \| null | |
| `gps_updated_at` | ISO ts \| null | `last_gps_at`. |
| `status` | enum | Evaluated in order: `critical` (open alerts) → `offline` (not online) → `disconnected` (GPS alive but battery telemetry stale >24 h, or SOC/SOH null) → `healthy`. **`disconnected` exists so a silent BMS never reads as healthy.** |

Sorted by `last_seen DESC NULLS LAST`. **Reads:** `vehicle_state` LEFT JOIN `vehicles`.

---

## 3.2 Battery Analytics tab

Six sub-tabs — Capacity & Health, Energy, Usage & Distance, Location, Electrical, Timeline —
each enabling only the queries it needs. All per-battery routes share the query contract in
[§4](#4-the-shared-analytics-query-contract). All are **`ceo` only**.

### `GET /api/telemetry/devices`

Doubles as the battery picker (`?limit=1000`) and the Device Management table (`?limit=100`).

- **Callers:** `BatteryAnalytics.tsx:202`, `DeviceManagement.tsx:15` · **Roles:** `ceo`, `dealer`

| Param | Default | Notes |
|---|---|---|
| `limit` | 50 | Not clamped. |
| `offset` | 0 | |

**`CAPTURED`** 2026-07-25 — 1 of 3 requested rows.

```json
{
  "success": true,
  "data": [
    { "device_id": "TK-51105-02DZ-213419", "vehicle_number": "TK-51105-02DZ-213419",
      "vehicle_type": null, "customer_name": null,
      "soc": 68, "soh": 100,
      "last_reading_at": "2026-07-25T11:33:00.893Z",
      "last_gps_at": "2026-07-25T11:46:30.858Z",
      "online": true, "open_alert_count": 0 }
  ]
}
```

`customer_name` is `vehicles.owner` and `vehicle_type` is `vehicles.makemodel` — **both null
fleet-wide**, as the capture shows. Only the alerts and activity endpoints enrich the name from
the CRM.

**Reads:** `vehicle_state` LEFT JOIN `vehicles`.

---

### `GET /api/telemetry/analytics/thresholds`

The red-flag limits that colour the Electrical charts.

- **Caller:** `BatteryAnalytics.tsx:212` · **Roles:** `ceo`
- **Param:** `vehicleno` (optional) — with it, fields defined by the vehicle's
  `battery_spec_models` row override the fleet-wide values.

**`CAPTURED`** 2026-07-25 — **with** `?vehicleno=TK-51105-02AZ-179422` (a vehicle that maps to a spec model):

```json
{
  "success": true,
  "data": {
    "underVoltageV": 44, "overVoltageV": 60, "overCurrentA": 70,
    "weakChargeCurrentA": 8, "overTemperatureC": 55,
    "capacityWarningFrac": 0.9, "capacityCriticalFrac": 0.8,
    "modelName": "LFP-51V-105AH",
    "specKeys": ["underVoltageV", "overVoltageV", "overCurrentA", "overTemperatureC"],
    "ratedCapacityAh": 105,
    "minMileageKmPerAh": 0.35, "maxMileageKmPerAh": 0.65
  }
}
```

**`CAPTURED`** 2026-07-25 — **without** `vehicleno` (fleet-wide), or with a vehicle that has no
`battery_model`. The seven numeric values are **byte-for-byte identical**; only the attribution
fields collapse:

```json
{
  "success": true,
  "data": {
    "underVoltageV": 44, "overVoltageV": 60, "overCurrentA": 70,
    "weakChargeCurrentA": 8, "overTemperatureC": 55,
    "capacityWarningFrac": 0.9, "capacityCriticalFrac": 0.8,
    "modelName": null, "specKeys": [], "ratedCapacityAh": null,
    "minMileageKmPerAh": null, "maxMileageKmPerAh": null
  }
}
```

> **Why the two look identical, and why that is not a bug.** There is exactly **one** row in
> `battery_spec_models` — `LFP-51V-105AH` — and its limits (44 / 60 / 70 / 55) are the *same
> numbers* as the hardcoded defaults, so spec resolution currently changes nothing visible. There
> is also **no `app_settings` override row**, so the middle rung is empty too. The resolver is
> working; it just has nothing to disagree with. `specKeys` is the only proof it ran.
>
> The one field that genuinely only exists via the spec is the **mileage band (0.35–0.65 km/Ah)** —
> without a `vehicleno` the mileage charts draw no band at all.

| Field | Type | Meaning |
|---|---|---|
| `underVoltageV` | float | Below this on a 48–60 V pack is a cell group collapsing under load. |
| `overVoltageV` | float | Overcharge, or a BMS that lost its reference. |
| `overCurrentA` | float | Above this on a pack peaking near 57 A is abuse or a decode fault. |
| `weakChargeCurrentA` | float | Average current **inside a detected charging cycle** below which the charge is unusually weak. Deliberately *not* a naive instantaneous test — that would fire on every parked vehicle. |
| `overTemperatureC` | float | Thermal event. |
| `capacityWarningFrac` | float | Fraction of the pack's **own** nameplate below which capacity warns. 0.9 × 105 Ah = 94.5 Ah. |
| `capacityCriticalFrac` | float | Same, critical. Must be strictly below the warning fraction. |
| `modelName` | string \| null | The `battery_spec_models` row that supplied spec fields, when `vehicleno` resolved to one. |
| `specKeys` | string[] | Which fields the model spec overrode — lets the UI attribute a band to the spec rather than to fleet settings. |
| `ratedCapacityAh` | float \| null | Spec-only nameplate. Fallback where the CAN payload has none. |
| `minMileageKmPerAh` / `maxMileageKmPerAh` | float \| null | E-201 normal-efficiency band, drawn on the three mileage charts. **Spec-only** — null means no band was recorded, and the chart draws no line rather than inventing a fleet number. |

**Resolution order, per field:** model spec → `app_settings` row → env var → hardcoded default.
Only the seven numeric fields have all four rungs; `ratedCapacityAh` and the mileage band are
spec-only, because a nameplate is a property of the pack, not a display preference.

Defaults (`thresholds-math.ts`): 44 V / 60 V / 70 A / 8 A / 55 °C / 0.9 / 0.8. Env overrides:
`TELEMETRY_UNDER_VOLTAGE_V`, `TELEMETRY_OVER_VOLTAGE_V`, `TELEMETRY_OVER_CURRENT_A`,
`TELEMETRY_WEAK_CHARGE_CURRENT_A`, `TELEMETRY_OVER_TEMPERATURE_C`,
`TELEMETRY_CAPACITY_WARNING_FRAC`, `TELEMETRY_CAPACITY_CRITICAL_FRAC`.

> The voltage and current defaults are **placeholders** sized to what this fleet's telemetry
> shows, not manufacturer limits. Replace them before anyone acts on a breach count.

**Reads:** `app_settings`, `device_battery_map` ⋈ `battery_spec_models` (RDS).

### `PUT /api/telemetry/analytics/thresholds`

Body: any subset of the seven numeric keys. Each must be a **finite number > 0** — the value
lands in a `jsonb` column that later feeds SQL comparisons, so unknown keys are dropped and
non-finite values rejected. Cross-field validation runs against the *merged* result:
`capacityWarningFrac > capacityCriticalFrac` and `overVoltageV > underVoltageV`, else `400`.
Returns the new resolved thresholds.

> **These are display thresholds only.** They change what this dashboard calls a breach. They do
> **not** change what the poller alerts on — that lives in `iot_stack/poller/poll.py`, outside
> this repo. See §17 of the calculations doc.

---

### `GET /api/telemetry/analytics/cadence`

The honest counter to "the device reads every 30 s".

- **Caller:** `BatteryAnalytics.tsx:224` · **Params:** [§4](#4-the-shared-analytics-query-contract) (`granularity` unused)

**`CAPTURED`** 2026-07-25 for `TK-51105-09LY-171632`, 3-month window:

```json
{ "success": true,
  "data": { "medianIntervalS": 3690.058, "p90IntervalS": 3840.063,
            "samplesPerDay": 19.2, "lastSampleAt": "2026-07-25T11:38:56.522Z",
            "duplicatePct": 82 } }
```

> **Read those numbers before trusting anything sampled from `telemetry_can`.** The median gap is
> **3,690 s — over an hour**, not the ~510 s quoted in older reviews, and **82% of rows are
> duplicates**. Only **19.2 distinct samples per day** survive against a device that streams every
> 30 s. Cadence varies per battery and keeps drifting, which is exactly why this endpoint exists
> and why `electrical-trend` reports its own measured gap rather than a constant.

| Field | Type | Meaning |
|---|---|---|
| `medianIntervalS` | float \| null | Median seconds between **distinct** stored samples. |
| `p90IntervalS` | float \| null | The fat tail the median hides. Has drifted from ~2,010 s to ~3,720 s. |
| `samplesPerDay` | float \| null | Distinct samples ÷ window days. |
| `lastSampleAt` | ISO string \| null | Newest stored sample. |
| `duplicatePct` | float \| null | Share of rows that merely repeat an existing timestamp. |

Null everywhere means the window held too few samples to measure a gap — the card must say so
rather than print a fallback number.

**Reads:** `telemetry_can`.

---

### `GET /api/telemetry/analytics/ah-trend`

Charging cycles and per-cycle capacity estimates. The Capacity & Health sub-tab.

- **Caller:** `BatteryAnalytics.tsx:234` · **Params:** `vehicleno` (required), `months`, `month`, `from`, `to`
  *(this route parses them itself rather than via `_params.ts` — behaviour is the same, `granularity` is not read)*

**`CAPTURED`** 2026-07-25 for `TK-51105-09LY-171632` — 2 of 40 sessions.

```json
{
  "success": true,
  "data": {
    "vehicleno": "TK-51105-09LY-171632", "months": 3, "month": null, "from": null, "to": null,
    "sessions": [
      { "cycle_no": 1,
        "start_time": "2026-04-25T15:04:13.414Z", "end_time": "2026-04-25T15:38:27.556Z",
        "duration_s": 2054, "ah_charged": 6.06,
        "start_soc": 93, "end_soc": 100, "soc_difference": 7,
        "avg_charging_current": 19.3, "max_charging_current": 19.8,
        "coverage_pct": 100, "n_samples": 9, "n_current_samples": 8,
        "avg_sampling_interval_s": 256.8, "max_gap_s": 974.145,
        "rated_capacity_ah": 105, "estimated_capacity_ah": 86.6,
        "capacity_confidence": "low", "capacity_plausible": true,
        "is_topup": false, "enough_samples": true },
      { "cycle_no": 2,
        "start_time": "2026-04-26T12:01:40.650Z", "end_time": "2026-04-26T13:39:52.054Z",
        "duration_s": 5891, "ah_charged": 28.3,
        "start_soc": 73, "end_soc": 100, "soc_difference": 27,
        "avg_charging_current": 20.9, "max_charging_current": 21,
        "coverage_pct": 100, "n_samples": 19, "n_current_samples": 14,
        "avg_sampling_interval_s": 327.3, "max_gap_s": 999.701,
        "rated_capacity_ah": 105, "estimated_capacity_ah": 104.8,
        "capacity_confidence": "high", "capacity_plausible": true,
        "is_topup": false, "enough_samples": true }
    ],
    "summary": {
      "chargingCycles": 40, "totalAhCharged": 1403.4, "avgAhPerSession": 35.1,
      "avgCapacityAh": 100.4, "avgSessionDurationMin": 241, "avgSocGained": 34.8,
      "avgSamplingIntervalS": 340.2,
      "capacityConfidence": { "high": 30, "medium": 7, "low": 3 },
      "topUpCycles": 0, "ratedCapacityAh": 105, "implausibleCycles": 1,
      "gates": { "minSocDifference": 20, "minCoveragePct": 15, "minSamples": 5 }
    }
  }
}
```

The two captured cycles are a **worked example of the confidence grading**. Both have 100%
coverage and enough samples, and both are "plausible" — but cycle 1 gained only 7% SOC, so its
`estimated_capacity_ah` of **86.6 Ah** is an extrapolation from a 7-point swing and is graded
`low`. Cycle 2 swung 27% and lands at **104.8 Ah** against a 105 Ah nameplate, graded `high`.
Plot the first as though it were the second and you have invented 18 Ah of degradation. This is
why `avgCapacityAh` (100.4) averages only the 30 `high` cycles.

**`sessions[]`**

| Field | Type | Meaning |
|---|---|---|
| `cycle_no` | int | 1-based, chronological — the "Charging Cycle Number". |
| `start_time` / `end_time` | ISO ts | `end_time` is the last *rising* sample, not the last row in the window. |
| `duration_s` | int | Deliberately excludes the first attributed interval. |
| `ah_charged` | float | Trapezoidal integral of \|pack current\| over the cycle's actual elapsed time. |
| `start_soc` / `end_soc` / `soc_difference` | float \| null | The swing the capacity extrapolation divides by. |
| `avg_charging_current` / `max_charging_current` | float \| null | Averaged over samples actually carrying current. |
| `coverage_pct` | float \| null | % of elapsed time covered by intervals short enough to trust. Low coverage **lowers the confidence grade rather than deleting the estimate**. |
| `n_samples` / `n_current_samples` | int | Total integrated / of those, how many carried a current reading. |
| `avg_sampling_interval_s` | float \| null | `duration ÷ (n_samples − 1)` — n−1 intervals, not n. |
| `max_gap_s` | float \| null | The widest silence inside the charge. |
| `rated_capacity_ah` | float \| null | BMS nameplate. |
| `estimated_capacity_ah` | float \| null | `ah_charged ÷ (Δsoc/100)`. **Estimated on every cycle whose SOC rose — never withheld.** Null only when ΔSOC ≤ 0. |
| `capacity_confidence` | `"high"` \| `"medium"` \| `"low"` | **Always read this with the estimate.** A `low` grade is arithmetically valid and epistemically worthless — never plot it on a degradation trend as though it were `high`. |
| `capacity_plausible` | bool | Within 0.3×–1.5× of nameplate. Implausible points must not scale the chart axis. |
| `is_topup` | bool | Gained less than the minimum swing — a real charge, just a small one. Counted, not discarded. |
| `enough_samples` | bool | Had enough samples for the integral to mean anything. |

**`summary`** — `avgCapacityAh` averages **high-confidence estimates only** (averaging in a
2%-swing extrapolation, where error is amplified ×50, would drag the headline toward noise);
`capacityConfidence` gives the counts so the smaller denominator is never a mystery;
`implausibleCycles` counts estimates contradicting the nameplate — a measurement fault;
`gates` echoes the thresholds in force so the UI can say what it graded and why.

**Reads:** `telemetry_battery` (+ `telemetry_can` for nameplate). **Maths:** §2–§5.

---

### `GET /api/telemetry/analytics/soc-timeline`

SOC against time, tagged with cycle membership — the chart that makes cycle detection
falsifiable by eye.

- **Caller:** `BatteryAnalytics.tsx:314` · **Params:** `vehicleno`, `months`, `month`, `from`, `to`

**`CAPTURED`** 2026-07-25 — 2 of the returned points.

```json
{ "success": true,
  "data": { "vehicleno": "TK-51105-09LY-171632", "months": 3, "month": null, "from": null, "to": null,
            "points": [ { "time": "2026-04-25T12:14:17.543Z", "soc_pct": 93, "in_cycle": false },
                        { "time": "2026-04-25T12:51:51.946Z", "soc_pct": 93, "in_cycle": false } ] } }
```

`in_cycle` shades what the dashboard actually **counts** (post-validation), so the chart can
never disagree with the cycle count beside it. Points are evenly strided down to
`MAX_TIMELINE_POINTS` = 4000 — striding, not averaging, because averaging would smooth away the
sharp SOC transitions this chart exists to expose. **In-cycle samples are never strided away**: a
short charge can hold as few as two stored samples.

**Reads:** `telemetry_battery`.

---

### `GET /api/telemetry/analytics/discharge-cycles`

- **Caller:** `BatteryAnalytics.tsx:242` · **Params:** [§4](#4-the-shared-analytics-query-contract)

**`CAPTURED`** 2026-07-25 — 1 of 9 cycles, via the route (not the bare fetcher, which omits `km`).

```json
{
  "success": true,
  "data": {
    "vehicleno": "TK-51105-09LY-171632", "months": 3, "month": null, "from": null, "to": null,
    "cycles": [
      { "break_id": 1,
        "start_time": "2026-05-25T01:54:26.762Z", "end_time": "2026-05-25T08:54:57.025Z",
        "duration_s": 25230, "start_soc": 100, "end_soc": 35, "min_soc": 35, "dod_pct": 65,
        "ah_discharged_soc": 68.25, "ah_discharged_coulomb": 89.16, "divergence_pct": 30.6,
        "avg_discharge_current": 22.5, "max_discharge_current": 49, "n_samples": 29,
        "coulomb_trustworthy": true, "rated_capacity_ah": 105, "rated_capacity_source": "can",
        "km": 73.7, "km_source": "calibrated", "km_per_ah": 1.08 }
    ],
    "summary": { "dischargeCycles": 9, "totalAhDischarged": 280.3,
                 "avgDepthOfDischarge": 29.7, "avgAhPerCycle": 31.1,
                 "medianDivergencePct": 28.1, "coulombTrustworthyCycles": 9,
                 "ratedCapacityAh": 105 },
    "gates": { "minSocDrop": 5, "minSamples": 5, "deepEnterPct": 20, "deepExitPct": 25 }
  }
}
```

Two things the capture settles:

- **There is a top-level `gates` object** (the discharge/deep-discharge gates), alongside
  `vehicleno`/`months`/`month`/`from`/`to`. The client type in `battery/types.ts` declares only
  `cycles` and `summary`, so these travel over the wire but are not consumed.
- **The two Ah figures disagree by 30.6% on this cycle** (68.25 SOC-derived vs 89.16
  coulomb-counted), and the window median is 28.1%. `coulomb_trustworthy` is still `true` — it
  attests the integral had enough samples, **not** that the two methods agree. At this cadence
  (median gap over an hour) prefer `ah_discharged_soc`; §2.5 of the cards doc explains why.

| Field | Type | Meaning |
|---|---|---|
| `break_id` | int | Groups this cycle's samples; also the join key for the merged distance. |
| `dod_pct` | float \| null | Depth of discharge. |
| `ah_discharged_soc` | float \| null | **PRIMARY.** From the SOC endpoints — survives sparse sampling. |
| `ah_discharged_coulomb` | float \| null | **SECONDARY.** Coulomb-counted; null when too sparse to integrate. |
| `divergence_pct` | float \| null | Disagreement between the two. High divergence means the sampling could not support the integral. |
| `coulomb_trustworthy` | bool | Whether the coulomb figure can be quoted at all. |
| `rated_capacity_source` | `"can"` \| `"spec"` \| null | Whether the nameplate came from the CAN payload or the E-190 model spec. |
| `km` | float \| null | Distance inside the cycle window. **Merged in by this route**, not by the underlying fetcher — `energy-trend` and `discharge-vs-km` reuse that fetcher and must not pay the GPS query twice. |
| `km_source` | `"calibrated"` \| `"gps"` \| null | `gps` = an uncalibrated chord, i.e. a **lower bound** — the panel says so. |
| `km_per_ah` | float \| null | Mileage as a driver reads it. |

**Reads:** `telemetry_can`, `telemetry_gps`, `distance_rollup`. **Maths:** §12–13.

---

### `GET /api/telemetry/analytics/deep-discharge`

Deep-discharge events, debounced by a Schmitt trigger so one physical event is one row rather
than one per sample.

- **Caller:** `BatteryAnalytics.tsx:250` · **Params:** [§4](#4-the-shared-analytics-query-contract)

**`CAPTURED`** 2026-07-25 — this battery had **no** deep-discharge events in the window:

```json
{ "success": true,
  "data": { "vehicleno": "TK-51105-09LY-171632", "months": 3, "month": null, "from": null, "to": null,
            "events": [], "byMonth": [],
            "gates": { "minSocDrop": 5, "minSamples": 5, "deepEnterPct": 20, "deepExitPct": 25 } } }
```

**`ILLUSTRATIVE`** — the shape when events are found:

```json
{ "events": [ { "event_id": 7, "start_time": "2026-06-11T13:02:00.000Z",
                "end_time": "2026-06-11T14:47:00.000Z", "duration_s": 6300,
                "min_soc": 11, "n_samples": 9, "duration_confident": true } ],
  "byMonth": [ { "month": "2026-05", "count": 2 }, { "month": "2026-06", "count": 3 } ] }
```

`duration_confident: false` means the low SOC is real but the span is not observed — the event
happened; how long it lasted is unknown. **Reads:** `telemetry_can`. **Maths:** §14.

---

### `GET /api/telemetry/analytics/energy-trend`

Ah in and Ah out per bucket with running totals. Charge comes from the same aggregate that feeds
the Charging Cycles card, so the two can never disagree.

- **Caller:** `BatteryAnalytics.tsx:263` (`granularity=month`) · **Params:** [§4](#4-the-shared-analytics-query-contract)

**`CAPTURED`** 2026-07-25 — 2 of the returned buckets.

```json
{ "success": true,
  "data": { "vehicleno": "TK-51105-09LY-171632", "granularity": "month",
    "buckets": [ { "bucket": "2026-04-01T00:00:00.000Z", "ah_charged": 171.5, "ah_discharged": 0,
                   "cum_charged": 171.5, "cum_discharged": 0 },
                 { "bucket": "2026-05-01T00:00:00.000Z", "ah_charged": 1164.3, "ah_discharged": 249.9,
                   "cum_charged": 1335.8, "cum_discharged": 249.9 } ],
    "summary": { "totalCharged": 1403.5, "totalDischarged": 280.3,
                 "chargingCycles": 40, "dischargeCycles": 9, "netAh": 1123.2 } } }
```

> **`bucket` is a full ISO timestamp, not a `"YYYY-MM"` label** — even at month granularity it is
> the bucket's start instant. The same applies to `distance-trend` and `electrical-trend`.
>
> Note the asymmetry: **40 charging cycles but only 9 discharge cycles**, so `netAh` is +1123.2.
> That is a detection artefact, not a battery creating energy — discharge detection needs a clean
> SOC descent, and at a >1 h sample gap most descents are too fragmented to qualify. Do not read
> `netAh` as an energy balance.

**Reads:** `telemetry_can`, `telemetry_battery`. **Maths:** §13.

---

### `GET /api/telemetry/analytics/distance-trend`

Kilometres per bucket plus the running total.

- **Callers:** `BatteryAnalytics.tsx:273` (`granularity=month`) and `:282` (period granularity)
- **Params:** [§4](#4-the-shared-analytics-query-contract)

**`CAPTURED`** 2026-07-25 — 2 of 73 buckets.

```json
{ "success": true,
  "data": { "vehicleno": "TK-51105-09LY-171632", "months": 3, "month": null, "from": null, "to": null,
    "granularity": "day",
    "buckets": [ { "bucket": "2026-04-26T00:00:00.000Z", "km": 27.9, "cum_km": 27.9, "has_telemetry": false },
                 { "bucket": "2026-04-27T00:00:00.000Z", "km": 31.8, "cum_km": 59.7, "has_telemetry": false } ],
    "summary": { "totalKm": 1537, "activeBuckets": 70, "bucketsWithoutDistance": 3,
                 "avgKmPerActiveBucket": 22, "activeDays": 70, "avgKmPerActiveDay": 22 } } }
```

> **`has_telemetry: false` alongside a non-null `km` is normal, not a contradiction.** The two
> come from different tables: `km` from `distance_rollup`, `has_telemetry` from whether *battery*
> samples exist in that bucket. A day can have a distance rollup with no surviving CAN samples.
> The flag only exists to distinguish a parked vehicle from a dead tracker when `km` is null.

| Field | Notes |
|---|---|
| `km` | **`null` = unknown and MUST render as a gap, never as a zero.** |
| `has_telemetry` | Lets the UI distinguish a parked vehicle (0 km) from a dead tracker (a gap). |
| `activeDays` / `avgKmPerActiveDay` | Always day-grained, regardless of the chart's granularity. |

**Reads:** `distance_rollup` (`bucket_size='day'`). **Maths:** §15.

---

### `GET /api/telemetry/analytics/discharge-vs-km`

Ah discharged against kilometres — **per day**, plus a per-cycle scatter.

- **Caller:** `BatteryAnalytics.tsx:290` · **Params:** [§4](#4-the-shared-analytics-query-contract)

> Per day rather than per cycle is a **data constraint, not a preference**: distance exists only
> as a daily rollup and `trips` is empty, so splitting a day's kilometres between the discharge
> cycles inside it would be an invention. The per-cycle series that *does* exist is reconstructed
> from GPS chords over each cycle's own window.

**`CAPTURED`** 2026-07-25 — 1 point and 1 cycle of the returned sets.

```json
{
  "success": true,
  "data": {
    "vehicleno": "TK-51105-09LY-171632",
    "points": [ { "day": "2026-05-25T00:00:00.000Z", "km": 75.3, "ah_discharged": 68.3,
                  "ah_per_km": 0.907, "km_per_ah": 1.1, "cycles": 1 } ],
    "cycles": [ { "break_id": 1, "start_time": "2026-05-25T01:54:26.762Z",
                  "end_time": "2026-05-25T08:54:57.025Z", "duration_s": 25230, "dod_pct": 65,
                  "km": 73.7, "km_source": "calibrated", "ah_discharged": 68.25,
                  "ah_per_km": 0.926, "km_per_ah": 1.08,
                  "avg_discharge_current": 22.5, "max_discharge_current": 49,
                  "overload_index": 1.2, "current_index": 1.1 } ],
    "cycleSummary": {
      "cycles": 9, "totalKm": 310.5, "totalAh": 280.3, "avgAhPerKm": 0.903,
      "cyclesWithoutDistance": 0, "calibratedPct": 100,
      "baseline": { "ahPerKm": 0.773, "cycles": 2, "km": 67.9 },
      "overloadedCycles": 3, "baselineAvgCurrent": 20.4, "heavyCurrentCycles": 1,
      "gates": { "baselineMinCycles": 8, "baselineMinKm": 50, "baselineKmFraction": 0.2,
                 "overloadIndexWarn": 1.25, "currentLoadIndexWarn": 1.25, "minTripKm": 1 }
    },
    "summary": { "days": 7, "totalKm": 266.2, "totalAh": 233.2,
                 "avgAhPerKm": 0.876, "daysWithoutDischarge": 63 }
  }
}
```

> **`baseline.cycles: 2` against `baselineMinCycles: 8` is correct.** The gate is the minimum
> number of *qualifying cycles in the window* needed before a baseline is attempted (9 ≥ 8); the
> baseline itself is then the pack's **best fifth** of those — 2 cycles. The two numbers count
> different things.
>
> Real mileage here is **~1.1 km/Ah**, well above the model spec's 0.35–0.65 band, so this pack
> plots above the band rather than inside it. `summary` (7 days with a discharge cycle) and
> `cycleSummary` (9 cycles) also disagree by construction — a day can hold more than one cycle.

| Field | Meaning |
|---|---|
| `overload_index` | This cycle's Ah/km against the pack's **own best-fifth** baseline. >1 = spent more charge per km than this same pack does at its lightest. **Null = no baseline was computable, which is NOT the same as 1.0.** |
| `current_index` | This cycle's average current against the pack's own median. Null = uncharacterisable, again not 1.0. |
| `cycleSummary.baseline` | The pack's own light-load reference. Null when the window cannot support one. |
| `calibratedPct` | % of plotted cycles whose km was calibrated against the daily rollup; the rest are uncalibrated GPS chords. |

**Reads:** `telemetry_can`, `telemetry_gps`, `distance_rollup`. **Maths:** §15, `load-math.ts`.

---

### `GET /api/telemetry/analytics/electrical-trend`

Bucketed voltage / current / temperature statistics plus breach counts.

- **Caller:** `BatteryAnalytics.tsx:298` · **Params:** [§4](#4-the-shared-analytics-query-contract)

**`CAPTURED`** 2026-07-25 — 1 of the returned buckets.

```json
{
  "success": true,
  "data": {
    "vehicleno": "TK-51105-09LY-171632", "months": 3, "month": null, "from": null, "to": null,
    "granularity": "day",
    "buckets": [ { "bucket": "2026-05-25T00:00:00.000Z",
      "v_min": 51.9, "v_p05": 52, "v_med": 52.8, "v_p95": 55.5, "v_max": 56.5,
      "i_min": 0, "i_med": 0, "i_p95": 27.1, "i_max": 49,
      "t_med": 46.3, "t_max": 46.3, "n": 45 } ],
    "thresholds": { "underVoltageV": 44, "overVoltageV": 60, "overCurrentA": 70,
                    "weakChargeCurrentA": 8, "overTemperatureC": 55,
                    "capacityWarningFrac": 0.9, "capacityCriticalFrac": 0.8,
                    "modelName": "LFP-51V-105AH",
                    "specKeys": ["underVoltageV", "overVoltageV", "overCurrentA", "overTemperatureC"],
                    "ratedCapacityAh": 105,
                    "minMileageKmPerAh": 0.35, "maxMileageKmPerAh": 0.65 },
    "breaches": { "underVoltage": 0, "overVoltage": 0, "overCurrent": 0,
                  "overTemperature": 0, "weakCharge": 0 },
    "summary": { "nSamples": 1180, "chargingCycles": 40, "medianSampleGapS": 3690.058 }
  }
}
```

`thresholds` carries the **full resolved object**, `modelName` / `specKeys` included — the same
payload as `GET analytics/thresholds?vehicleno=…`, so the chart never has to make a second call.

> **All five breach counts are zero, and that is close to meaningless here.** `medianSampleGapS`
> is **3,690 s** — this pack is observed roughly once an hour. A voltage sag or current spike
> lasting seconds has a fraction of a percent chance of landing in a sample. Zero breaches means
> *none were caught*, not *none occurred*. `i_med: 0` for the whole day says the same thing from
> the other side: most samples land while the vehicle is idle.

> **The breach counts are LOWER BOUNDS.** A transient lasts seconds and the pack is sampled
> every ~510 s, so roughly 1% of them are caught. `medianSampleGapS` is **measured over this
> window for this battery** (not a fleet constant) precisely so the card can show the reader why.
> Null when there were too few samples to measure a gap — the card must say so rather than fall
> back to a number.

**Reads:** `telemetry_can` + thresholds from RDS. **Maths:** §16–17.

---

### `GET /api/telemetry/analytics/geo`

Location analytics for one battery: kilometre heat map, dwell clusters, and the inferred
parking / home / charging places.

- **Caller:** `BatteryAnalytics.tsx:306` · **Params:** [§4](#4-the-shared-analytics-query-contract)

**`CAPTURED`** 2026-07-25 — `heat` and `dwell` abridged to 2 entries each.

```json
{
  "success": true,
  "data": {
    "vehicleno": "TK-51105-09LY-171632", "months": 3, "month": null, "from": null, "to": null,
    "heat": [ { "lat": 25.426, "lon": 81.923, "km": 163.38 },
              { "lat": 25.378, "lon": 81.967, "km": 127.423 } ],
    "dwell": [ { "lat": 25.378, "lon": 81.967, "hours": 1798.16, "observedHours": 1345.46,
                 "visits": 98, "nightHours": 469.59, "nights": 73, "lastNight": "2026-07-25" },
               { "lat": 25.378, "lon": 81.966, "hours": 99.65, "observedHours": 99.65,
                 "visits": 2, "nightHours": 27.73, "nights": 5, "lastNight": "2026-06-15" } ],
    "parking":  { "lat": 25.378, "lon": 81.967, "hours": 1798.16, "observedHours": 1345.46,
                  "visits": 98, "nightHours": 469.59, "nights": 73, "lastNight": "2026-07-25" },
    "home":     { "lat": 25.378, "lon": 81.967, "hours": 1798.16, "observedHours": 1345.46,
                  "visits": 98, "nightHours": 469.59, "nights": 73, "lastNight": "2026-07-25" },
    "charging": { "lat": 25.378, "lon": 81.967, "hours": 1798.16, "observedHours": 1345.46,
                  "visits": 98, "nightHours": 469.59, "nights": 73, "lastNight": "2026-07-25",
                  "chargeHours": 145.56, "chargeSessions": 36 },
    "overnightSecondary": { "lat": 25.378, "lon": 81.966, "hours": 99.65, "observedHours": 99.65,
                            "visits": 2, "nightHours": 27.73, "nights": 5, "lastNight": "2026-06-15" },
    "bbox": { "minLat": 25.368914, "maxLat": 25.608142,
              "minLon": 81.827846, "maxLon": 82.076437 },
    "summary": { "gpsChordKm": 1217.2, "fixes": 2977, "movingHours": 257.3,
                 "dwellHours": 1937.9, "inferredDwellPct": 23.4, "days": 76 },
    "gates": { "dwellRadiusM": 100, "moveMinM": 30, "dwellTrustGapS": 21600,
               "nightStartHour": 22, "nightEndHour": 5, "gridDeg": 0.001,
               "chargingSpotMinSessions": 2, "secondaryOvernightMinNights": 2 }
  }
}
```

`parking`, `home` and `charging` **all resolve to the same coordinate** on this vehicle — it
parks, sleeps and charges in one place. They are separate fields because they are separately
derived, not because they must differ.

Compare `summary.gpsChordKm` (**1,217 km**) with the same window's `distance-trend.totalKm`
(**1,537 km**): the chord sum is 21% low, exactly as the "lower bound, never quote it as a
distance" warning predicts. `inferredDwellPct: 23.4` means a quarter of the dwell hours were
inferred across telemetry gaps rather than observed.

| Field | Meaning |
|---|---|
| `heat[]` | Grid cells with `km` as the weight. |
| `dwell[].observedHours` | Of the total dwell hours, how many were actually **watched** — the rest are inferred across telemetry gaps. `inferredDwellPct` summarises this. |
| `home` | Where it sleeps. **A behavioural inference, never an address.** |
| `charging` | Stationary time inside rising-SOC windows, ≥ 2 sessions. |
| `summary.gpsChordKm` | Straight-line hops between fixes — **a LOWER BOUND. Never quote it as a distance.** Real distance is `distance_rollup`. |

**Reads:** `telemetry_gps`. **Maths:** §20.

---

### `GET /api/telemetry/analytics/charging-export.xlsx`

The Charging Analysis workbook. **Not JSON on success** — returns a binary `.xlsx`.

- **Caller:** `ExportChargingAnalysis.tsx:28` · **Roles:** `ceo`
- **Params:** `vehicleno` (required), `months` (default 3), `month` (`YYYY-MM`), `from`+`to` (`YYYY-MM-DD`, both or neither, `from ≤ to`)

**Success:** `200`, `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
`Content-Disposition: attachment; filename="charging-analysis_<vehicle>_<period>.xlsx"`.
Sheets: `Summary`, one sheet per charging cycle, and `Master Raw Data`.

**Failure:** JSON `400` in the standard error envelope. Everything that can fail does so
**before a single byte is written**, so the client gets either a clean error or a complete file —
never a truncated download behind a 200. Rejections:

| Condition | Message |
|---|---|
| no `vehicleno` | `vehicleno is required` |
| malformed `month` / `from` / `to` | format-specific |
| 0 samples in window | `No telemetry found for <vehicle> in the selected period.` |
| samples > `MAX_SAMPLES` (100,000) | asks for a narrower range |
| 0 cycles detected | `No charging cycles were detected …` |
| cycles > `MAX_CYCLES` (100) | asks for a narrower range |
| aggregate/detail cycle-count mismatch | throws — refuses to ship a workbook whose raw rows contradict its totals |

---

## 3.3 Fleet Activity tab

### `GET /api/telemetry/trips/overview`

Per vehicle, per day activity. **Despite the path, this does not read `trips`.**

- **Caller:** `TripAnalytics.tsx:36` (`?limit=200`) · **Roles:** `ceo`
- **Param:** `limit` — default 100, **clamped to 1–500**

**`CAPTURED`** 2026-07-25 — 2 of 5 requested rows.

```json
{
  "success": true,
  "data": {
    "rows": [ { "vehicle_number": "TK-64105-04DZ-013630", "customer_name": null,
                "day": "2026-07-24T00:00:00.000Z", "distance_km": 161.1 },
              { "vehicle_number": "TK-51105-02DZ-213416", "customer_name": null,
                "day": "2026-07-24T00:00:00.000Z", "distance_km": 155.7 } ],
    "tripsTableRows": 0,
    "summary": { "vehicles": 300, "totalKm": 305890, "avgKmPerDay": 57 }
  }
}
```

**`tripsTableRows: 0` is confirmed live** — the `trips` table is still empty, so the day really is
the finest grain available. Over the last 30 days, 300 vehicles covered **305,890 km**, averaging
57 km per vehicle-day. `customer_name` is null here because the CRM enrichment only fires when
`device_battery_map.customer_name` is populated for that vehicle.

| Field | Meaning |
|---|---|
| `rows[]` | `distance_rollup` day buckets with `distance_km > 0`, newest first, then largest first. |
| `customer_name` | Enriched from RDS `device_battery_map` — the IoT-side `vehicles.owner` is blank fleet-wide. |
| `tripsTableRows` | `count(*)` of the `trips` table. **`0` means the per-trip aggregator still has not run**, and the UI uses it to explain why a day is the finest grain available. The day it starts running, the UI stops explaining. |
| `summary` | Over the last 30 days. |

A day is the finest grain. Start/end points, trip duration and average speed live only in
`trips` and are simply not computed. **Reads:** `distance_rollup`, `trips` (count only),
`vehicles`, `device_battery_map`. **Maths:** §15.

---

## 3.4 Health & Analytics tab

### `GET /api/telemetry/health/degradation`

- **Caller:** `HealthAnalytics.tsx:72` (`?days=30`) · **Roles:** `ceo`
- **Param:** `days` — default 30, **clamped to 1–365**; a non-numeric value falls back to 30
  (it used to reach the query as `interval '1 day' * NaN` and return a silent empty trend)

**`CAPTURED`** 2026-07-25 — 2 of 21 trend days.

```json
{ "success": true,
  "data": {
    "trend": [ { "date": "2026-06-25T00:00:00.000Z", "avg_soh": 100, "min_soh": 100, "max_soh": 100 },
               { "date": "2026-06-26T00:00:00.000Z", "avg_soh": 100, "min_soh": 100, "max_soh": 100 } ],
    "verdict": { "kind": "informative" }
  } }
```

`verdict.kind` is one of `"constant"` (with `value` and `days`), `"informative"`, or `"empty"`.

> **The captured verdict says `informative`, and it is misleading.** 20 of the 21 days are flat
> 100/100/100. The 21st — **2026-07-15** — recorded `min_soh: 0`. `classifySohFeed` only asks
> whether the set of min/max values has more than one member, so that single zero (a dropout, not
> a measurement) is enough to flip the verdict away from `constant`.
>
> The result is that this endpoint reports a varying feed on the same fleet where
> `fleet/dashboard` and `analytics/warranty` both report `constantFeed: true` from the live
> snapshot. **The two are not contradicting each other about the fleet** — they are looking at
> different things (30-day history vs current state), and the history contains one bogus zero.
> Treat `informative` as trustworthy only after checking the trend for 0-valued days.

The series never travels alone. Every reporting pack returns exactly 100.0, so plotting it draws
a flat line at 100 that reads as "every battery is perfect" when it means "the BMS SOH feed is
stuck". `verdict` tells the caller which of those it is looking at. This is a **detection**, not
a hardcoded "this feed is dead" — the day the poller writes real values the verdict flips and the
chart returns with no code change.

This is the BMS's *reported* SOH, not a measurement. Measured capacity comes from the charging
cycle extrapolation (§3.2 `ah-trend`). **Reads:** `telemetry_battery`.

---

### `GET /api/telemetry/analytics/warranty`

- **Caller:** `HealthAnalytics.tsx:77` · **Roles:** `ceo` · **Params:** none

**`CAPTURED`** 2026-07-25 — the real response today:

```json
{ "success": true,
  "data": { "devices": [],
            "assessment": { "assessed": 304, "unassessable": 13,
                            "constantFeed": true, "constantValue": 100 } } }
```

**`ILLUSTRATIVE`** — the `devices[]` row shape, for if a pack ever drops below 80:

```json
{ "device_id": "TK-51105-02AZ-179422", "vehicle_number": "TK-51105-02AZ-179422", "soh": 74.2,
  "last_reading": "2026-07-24T09:14:32.000Z",
  "customer_name": "Ramesh Traders", "dealer_id": "DLR-0031" }
```

The capture confirms it: **304 packs assessed, 13 unassessable, every one of the 304 reporting
exactly 100.0.**

`soh_pct < 80` returns **zero rows on this fleet, and always will** — all reporting packs sit at
exactly 100.0. An empty list rendered as "No at-risk devices" would be the dead sensor wearing a
clean bill of health, so the list travels with `assessment`: how many packs the test could even
run on, how many reported nothing (**unmeasured, not healthy**), and whether the readings are all
identical, which makes a zero count uninformative by construction.

**Reads:** `vehicle_state`, `vehicles` (IoT) + `device_battery_map` (RDS).

---

### `GET /api/telemetry/analytics/dealer-comparison`

- **Caller:** `HealthAnalytics.tsx:82` · **Roles:** `ceo` · **Params:** none

**`CAPTURED`** 2026-07-25 — the real response today:

```json
{ "success": true, "data": [] }
```

> **This endpoint returns an empty array on the current data, and will until dealers are
> mapped.** Of the 285 rows in `device_battery_map`, **0 have a `dealer_id`** — and the query
> requires `status='active' AND dealer_id IS NOT NULL AND vehicle_number IS NOT NULL`, so it
> short-circuits before it ever reaches the IoT DB. (That is also why this was the one
> "IoT-backed" endpoint that captured cleanly with the tunnel down.)
>
> The same applies to `kpis.dealerPerformance` inside `fleet/dashboard` — same function, same
> empty result. An empty Health & Analytics dealer table is **not** a telemetry fault.

**`ILLUSTRATIVE`** — the shape once dealers are mapped:

```json
{ "success": true,
  "data": [ { "dealer_id": "DLR-0031", "devices": 42, "device_count": 42,
              "avg_soh": 100, "avg_soc": 63.4, "alerts": 3, "alert_count": 3 } ] }
```

`devices`/`device_count` and `alerts`/`alert_count` are duplicate keys carrying identical values
— legacy UI compatibility. Sorted by device count descending. `alerts` counts **vehicles with at
least one open alert**, not total alerts.

**Reads:** `device_battery_map` (RDS) → `vehicle_state` (IoT), aggregated in Node.

---

## 3.5 Alerts & Rules tab

### `GET /api/telemetry/alerts`

- **Caller:** `AlertsRules.tsx:14` (`?limit=50&acknowledged=false`) · **Roles:** `ceo`, `dealer`

| Param | Default | Notes |
|---|---|---|
| `limit` | 50 | |
| `acknowledged` | — | `"true"` ⇒ `resolved_at IS NOT NULL`; `"false"` ⇒ `IS NULL`; anything else ⇒ no filter. |

**`CAPTURED`** 2026-07-25 — 2 of 5 requested rows (one open, one already resolved).

```json
{ "success": true,
  "data": [ { "device_id": "TK-51105-02AZ-179396", "vehicle_number": "TK-51105-02AZ-179396",
              "alert_type": "offline", "severity": "warn",
              "message": "No GPS for >60 min", "value": null, "threshold": null,
              "created_at": "2026-07-25T12:00:16.841Z", "resolved_at": null,
              "acknowledged": false,
              "id": "TK-51105-02AZ-179396|offline|1784980816",
              "dealer_id": null, "customer_name": null },
            { "device_id": "TK-51105-04HY-122450", "vehicle_number": "TK-51105-04HY-122450",
              "alert_type": "offline", "severity": "warn",
              "message": "No GPS for >60 min", "value": null, "threshold": null,
              "created_at": "2026-07-25T11:58:17.748Z", "resolved_at": "2026-07-25T11:59:47.758Z",
              "acknowledged": true,
              "id": "TK-51105-04HY-122450|offline|1784980697",
              "dealer_id": null, "customer_name": null } ] }
```

Points the capture pins down:

- **`severity` is `"warn"`**, not `"warning"`.
- **`value` and `threshold` are null** on `offline` alerts — they only carry numbers for
  threshold-crossing types. Do not assume they are populated.
- The dominant alert type in practice is **`offline` — "No GPS for >60 min"**, which is a
  *reporting* fault, not a battery fault.
- The second row shows the resolution mechanic: `resolved_at` set ⇒ `acknowledged: true`. It was
  auto-resolved by the poller 90 seconds later, not acknowledged by a person — the two are
  indistinguishable in this payload, because the table records no actor.
- `dealer_id` and `customer_name` are null for the reason in §2.2: no mapping row carries a dealer.

| Field | Notes |
|---|---|
| `id` | **Synthetic**, built in Node as `<vehicleno>\|<alert_type>\|<epoch_seconds>`. The `alerts` table has no primary key the UI can use. This is what the ack button posts back. |
| `acknowledged` | Derived as `resolved_at IS NOT NULL`. |
| `dealer_id`, `customer_name` | Enriched from RDS `device_battery_map`. |

**Reads:** `alerts` (IoT) + `device_battery_map` (RDS).

### `POST /api/telemetry/alerts/acknowledge`

- **Caller:** `AlertsRules.tsx:31` · **Roles:** `ceo`, `dealer`
- **Body:** `{ "alertId": "TK-51105-02AZ-179422|low_soc|1753347272" }` — missing ⇒ `400 alertId required`;
  malformed ⇒ 500 with `Malformed alertId. Expected '<vehicleno>|<alert_type>|<epoch_seconds>'.`
- **Response:** `{ "success": true }` — **no `data` member**

**Writes:** `UPDATE alerts SET resolved_at = now()` matching vehicleno + alert_type + exact
timestamp, only where `resolved_at IS NULL`. **The acknowledging user is discarded** — the table
has no `acknowledged_by` column, so there is no audit trail of who acked what.

### `GET /api/telemetry/alerts/config`

- **Caller:** `AlertsRules.tsx:23` · **Roles:** `ceo`
- **Response:** `{ "success": true, "data": [] }` — **always an empty array**
  (**`CAPTURED`** 2026-07-25: confirmed `[]`; the function returns a literal, it never queries)

There is no `alert_config` table on the IoT DB. The thresholds the *alerting* pipeline fires on
live in `iot_stack/poller/poll.py`. The empty array makes the UI hide the configuration card.

### `PUT /api/telemetry/alerts/config`

- **Caller:** `AlertsRules.tsx:136` · **Roles:** `ceo` · **Body:** `{ alert_type, threshold, severity }`
- **Response:** **always fails** — `500`:
  `Alert thresholds are configured in iTarangIT/iot_stack (poller/poll.py), not in the CRM. Update them there and redeploy the poller.`
  (A missing `alert_type` short-circuits to `400` first.)

To change display thresholds instead, use `PUT /api/telemetry/analytics/thresholds` (§3.2).

---

## 3.6 Device Management tab

### `GET /api/telemetry/devices/status`

- **Caller:** `DeviceManagement.tsx:24` · **Roles:** `ceo`, `dealer` · **Params:** none
- **Note:** unlike `/devices`, this is **never dealer-scoped** — it returns the whole fleet.

**`CAPTURED`** 2026-07-25 — 1 of 317 rows.

```json
{ "success": true,
  "data": [ { "device_id": "TK-51105-02DZ-213419", "vehicle_number": "TK-51105-02DZ-213419",
              "status": "active",
              "last_can_at": "2026-07-25T11:33:00.893Z",
              "last_gps_at": "2026-07-25T11:46:30.858Z", "comm_status": "online" } ] }
```

| Field | Values | Rule |
|---|---|---|
| `status` | `active` \| `inactive` | Straight off `vehicle_state.online`. |
| `comm_status` | `online` \| `intermittent` \| `offline` | `last_gps_at` within 1 h → `online`; within 24 h → `intermittent`; else (or NULL) → `offline`. |

**Reads:** `vehicle_state`.

### `POST /api/telemetry/devices/mapping`

Create one CRM-side deployment mapping.

- **Caller:** `DeviceManagement.tsx:129` · **Roles:** `ceo`
- **Body:** `device_id` (required in practice), `battery_serial`, `vehicle_number`,
  `vehicle_type`, `customer_name`, `customer_phone`, `dealer_id`, `state`, `city` —
  every optional field stored as `null` when blank
- **Response:** `{ "success": true, "id": "DBM-1a2b3c4d" }`

**Writes:** one `device_battery_map` row (RDS) with `status: 'active'` and a server-generated
`DBM-<8 hex>` id.

### `POST /api/telemetry/devices/mapping/bulk`

- **Caller:** `DeviceManagement.tsx:186` · **Roles:** `ceo`
- **Body:** `{ "mappings": [ { …same fields as above… } ] }` — empty or non-array ⇒ `400 No mappings provided`
- **Response:** `{ "success": true, "data": { "created": 48, "failed": 2, "total": 50 } }`

Rows are inserted **one at a time in a loop, not a transaction** — a partial success is a normal
outcome, and the response reports counts only. **Which** rows failed, and why, is not returned.

---

## 3.7 Database Health tab

### `GET /api/system/database-monitor`

Note the path — this one is **not** under `/api/telemetry`.

- **Caller:** `DatabaseHealth.tsx:10` · **Roles:** `ceo` · **Params:** none

**`CAPTURED`** 2026-07-25 — top 3 of 108 rows.

```json
{ "success": true,
  "data": [ { "schema": "public", "table_name": "telemetry_can_default",
              "row_count": "3232844", "total_size": "7152 MB" },
            { "schema": "public", "table_name": "telemetry_battery_default",
              "row_count": "17783940", "total_size": "2709 MB" },
            { "schema": "public", "table_name": "telemetry_gps_default",
              "row_count": "4744284", "total_size": "603 MB" } ] }
```

Straight from `pg_stat_user_tables` on the **IoT** database, `schemaname = 'public'`, ordered by
total relation size descending.

- **`row_count` is a JSON string, not a number** — it is `n_live_tup` (a `bigint`), and the driver
  returns bigints as strings. Parse before doing arithmetic.
- It is also a planner **estimate**, not an exact count.
- **Table names are partitions**: `telemetry_can_default`, not `telemetry_can`. The tables in §2
  are partitioned parents; this endpoint lists the physical children, so a name here will not
  match a name in a query.
- The row counts are the clearest evidence for §2.1's two-series story: **`telemetry_battery` holds
  17.8M rows against `telemetry_can`'s 3.2M** — 5.5× more samples. `telemetry_can` nonetheless
  occupies 2.6× the disk (7,152 MB vs 2,709 MB), because every row stores a whole JSONB frame.

---

# 4. The shared analytics query contract

Eleven per-battery routes take the same query string, parsed once by `parseBatteryParams` in
`src/app/api/telemetry/analytics/_params.ts`. Centralised deliberately: when each route re-parsed
it by hand, the precedence between `from`/`to`, `month` and `months` drifted apart from
`buildTimeWindow()` on the server — and once it does, a chart's caption describes a window the
query never ran.

| Param | Type | Default | Notes |
|---|---|---|---|
| `vehicleno` | string | **required** | Missing ⇒ `400 { "success": false, "error": { "message": "vehicleno is required" } }`. |
| `months` | int | `3` | Trailing-window size. UI offers 1 / 3 / 6. |
| `month` | `YYYY-MM` | — | A specific calendar month. |
| `from` / `to` | `YYYY-MM-DD` | — | Explicit range. |
| `granularity` | `day` \| `week` \| `month` | `day` | Bucket size. Unrecognised values fall back to `day`. |

**Precedence** (`buildTimeWindow`): `from`+`to` → `month` → `months`. The route echoes back
`months` / `month` / `from` / `to` so the UI can caption the window it actually got, not the one
it asked for.

**Which routes use it:** `cadence`, `discharge-cycles`, `deep-discharge`, `energy-trend`,
`distance-trend`, `discharge-vs-km`, `electrical-trend`, `geo`.
`ah-trend`, `soc-timeline` and `charging-export.xlsx` parse the same params **independently**
(they predate the helper) and ignore `granularity` — behaviour is identical, but a change to the
contract must touch all three too.

`granularity` is stripped before the options reach `buildTimeWindow`; routes that do not bucket
(`cadence`, `geo`, `deep-discharge`, `discharge-cycles`, `discharge-vs-km`) simply never read it.

---

# 5. Appendix

## 5.1 Routes that exist but the dashboard never calls

Verified: no `fetch` call site anywhere in `src/`. They work, they are just unwired — useful for
debugging by curl, but do not assume changing them affects any screen.

| Route | Returns | Notes |
|---|---|---|
| `GET /api/telemetry/fleet/overview` | the CEO `kpis` object alone | `ceo` only, no params, **no degraded path** — it 500s when the tunnel is down. Superseded by `fleet/dashboard`. |
| `GET /api/telemetry/analytics/soc-trends` | `[{ date, avg_soc, min_soc, max_soc }]` | `?days` default 30, **unclamped and unguarded** — a non-numeric value still reaches the query as NaN, unlike `health/degradation`. |
| `GET /api/telemetry/devices/[deviceId]` | one device with live voltage / current / temperature / speed | The only endpoint exposing `vehicle_state.pack_*`. |
| `GET /api/telemetry/devices/[deviceId]/readings` | `?hours` default 24 | Raw `telemetry_battery` rows. **Captured: 737 rows in 24 h** (~1 every 117 s) — the high-cadence series. |
| `GET /api/telemetry/devices/[deviceId]/gps` | `?hours` default 24 | Raw `telemetry_gps` rows. **Captured: 103 rows in 24 h** (~1 every 14 min) — GPS really is snapshot-cadence, per §1.5. |
| `GET /api/telemetry/devices/[deviceId]/trips` | `?limit` default 20 | Reads `trips` — **captured: 0 rows**, confirming the table is empty. |
| `GET /api/telemetry/devices/mapping` | same payload as `GET /api/telemetry/devices` | `?limit` default 100. Despite the path it does **not** read `device_battery_map`. |

## 5.2 Legacy schema file — do not use

`src/lib/db/migrations/create_telemetry_schema.sql` creates `telemetry.battery_readings`,
`telemetry.gps_readings`, `telemetry.trips` and `public.alert_config` (with seeded thresholds).

**No code queries any of them.** The live tables are unprefixed and are documented in §2. The
seeded `alert_config` rows in particular describe thresholds that have no effect anywhere — the
real ones are in `iot_stack/poller/poll.py`. Treat the file as historical.

## 5.3 Recapturing these payloads

The captures in §3 are a snapshot of **2026-07-25**. To refresh them:

```bash
# 1. the IoT tunnel must be up on local port 5500 (see IOT_DATABASE_URL)
#    verify: Test-NetConnection 127.0.0.1 -Port 5500

# 2. read-only capture of all 29 endpoints
node --import tsx --env-file=.env.local scripts/_capture-intellicar-api.ts capture.json
```

The harness calls the query layer directly, so it needs **no dev server and no login**. It
tolerates per-endpoint failures (a dead tunnel degrades to 5/29 rather than aborting) and writes
one JSON file. Set `CAPTURE_VEHICLENO` to pin the per-battery routes to a specific pack;
otherwise it picks the first device the fleet returns.

Two caveats when refreshing:

- **`discharge-cycles` needs the route, not the fetcher.** `route.ts` merges the per-cycle
  distance itself, so `fetchDischargeAnalytics` alone omits `km` / `km_source` / `km_per_ah`. The
  block in §3.2 was captured by replicating that merge.
- **The port matters:** `IOT_DATABASE_URL` points at **5500**, not the 5433 in older runbooks —
  the IoT stack moved to AWS and the old VPS listener is frozen.

## 5.4 Reading this system when the numbers look wrong

| Symptom | Likely cause |
|---|---|
| Every card reads 0 and a banner mentions the SSH tunnel | IoT Postgres unreachable — that is the degraded path in §3.0, not missing data. `ssh -N -L 5433:127.0.0.1:5433 root@72.61.246.37`. |
| SOH cards show "—" | `sohFeed.constantFeed` is true — the BMS feed is stuck at 100.0. Working as designed. |
| Fleet Activity shows days, not trips | `tripsTableRows === 0`; the `iot_stack` segmentation job has never run. |
| A chart has gaps rather than zeros | `km: null` / `has_telemetry: false` — unknown, deliberately not drawn as 0. |
| Breach counts look implausibly low | They are lower bounds; compare against `medianSampleGapS`. |
| Capacity trend looks noisy | Check `capacity_confidence` — only `high` points belong on the trend line. |
| "Reads every 30 s" but the data is sparse | `telemetry_can` is a re-inserted snapshot (~100 distinct rows/day). `telemetry_battery` is the real 30 s series. See §2.1. |

---

*Sources: `src/app/api/telemetry/**/route.ts`, `src/app/api/system/database-monitor/route.ts`,
`src/lib/telemetry/{queries,battery-queries,geo-queries,thresholds,thresholds-math,charging-sql,geo-sql,vps-status,charging-export}.ts`,
`src/lib/intellicar/client.ts`, `src/lib/db/{iot,schema}.ts`,
`src/components/intellicar/**`.*
