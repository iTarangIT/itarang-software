# Why our vehicle data wasn't updating every 30 seconds — and how we fixed it

*A plain-language explanation. No technical background needed.*

---

## The one-line version

Our electric vehicles send battery data every 30 seconds — that part always worked.
But our reports were only showing it in big chunks (a reading every ~8 minutes, and
for some data only **once a day**). The detailed 30-second data existed the whole
time; we just weren't **collecting** it or **reading** it the right way. We fixed
both, so the data is now truly 30-second.

---

## What was supposed to happen

Every electric vehicle has a battery with a tiny computer inside it. That computer
measures the battery's vital signs — charge %, current, voltage — **every 30
seconds**. Our system is meant to collect all of those readings so we can build
accurate reports, like the **Charging Analysis** that tells us how healthy each
battery is.

## What was actually happening (the problem)

When someone downloaded a report, the readings were far apart — often **8 to 10
minutes** between rows, and battery data was sometimes a **full day behind**.

So instead of a smooth, detailed picture, we were getting a rough sketch. Anything
we calculated from it — like charging behaviour or battery health — was less
accurate, because we were "connecting the dots" across big gaps instead of
following the real curve.

---

## Why it happened (the real reason)

Here's the key point: **the vehicles were doing their job perfectly.** They really
were sending data every 30 seconds. The problem was entirely on our side — in how we
*asked for* the data and *where the reports looked* for it.

### A simple way to picture it

Think of each vehicle as a person keeping a **diary**. Every 30 seconds they write a
new line with the battery's vital signs.

There are two ways we can copy someone's diary:

1. **"What's your latest line?"** — they show you only the single most recent line.
2. **"Show me every line you've written since I last checked."** — they hand you all
   the lines, each 30 seconds apart.

Our system was mostly using **option 1** — asking *"what's your latest line?"* over
and over. The catch: if the person hadn't written a new line yet, we'd just copy the
**same line again**. And the one place we *did* use option 2 (ask for the full
diary), we only did it **once a day**.

So three things went wrong at once:

- The live data was full of repeats and looked coarse (~8 minutes between real
  changes).
- The detailed 30-second data was only fetched **once a day**, so reports were stale.
- On top of that, the reports were reading from the **"repeats" copy**, not the good
  30-second copy.

The 30-second data was there all along. We were simply asking for it the wrong way,
and the reports were opening the wrong file.

---

## How we approached it

We didn't guess — we checked, step by step:

1. **We confirmed the vehicles were fine.** We looked directly at the raw data and
   found the 30-second battery readings really did exist. That told us the fix had to
   be on our side, not the vehicle's.
2. **We traced the whole path** — from the vehicle, to the software that collects the
   data, into our databases, and out to the reports — to find the exact spot where the
   30-second detail was being lost.
3. **We mapped out the moving parts.** Along the way we found there were **several
   databases and more than one collector** involved — a big reason this had been so
   confusing. We wrote down which one feeds which, so every change we made landed in
   exactly the right place.

---

## How we solved it

We fixed it in three small, careful steps:

1. **Collect the detailed history continuously — not once a day.**
   Instead of asking for the full diary once a day, we now ask *"show me every line
   since I last checked"* every few minutes. This brings in the real 30-second battery
   readings all day long.

2. **Deliver it straight to the database the dashboards read.**
   We added a small, dedicated helper that writes the 30-second battery data into the
   exact database our dashboards use — without disturbing anything else that was
   already working.

3. **Point the reports at the good data.**
   The Charging Analysis report used to read the "repeats" copy. We changed it to read
   the 30-second copy instead. Crucially, we kept **every calculation exactly the
   same** — only the *source* of the data changed — so the reports stay consistent,
   just far more detailed.

---

## The result

The Charging Analysis report (and the battery dashboards) now show **real 30-second
data**. You can see it right in the report: the timestamps step forward 30 seconds at
a time —

```
10:16:36 → 10:17:06 → 10:17:36 → 10:18:06 → 10:18:36 …
```

— instead of jumping 8 minutes. Because we're now following the battery's true
behaviour instead of a rough sketch, the charging and battery-health numbers are much
more accurate.

---

## Before and after, at a glance

**Before**

> Vehicle writes a line every 30s  →  we ask *"latest line?"* (get repeats) + full
> diary **once a day**  →  reports read the *"repeats"* copy  →  **big gaps in reports**

**After**

> Vehicle writes a line every 30s  →  we ask *"everything since last time"* every few
> minutes  →  30-second data lands in the **dashboard's** database  →  reports read the
> **30-second** copy  →  **smooth 30-second detail**

---

## In short

- The vehicles were **never** the problem — they always sent data every 30 seconds.
- We were asking for it the **wrong way** (only the "latest" reading) and pulling the
  detailed history only **once a day**.
- The reports were also reading the **coarse copy**.
- We fixed **how** we collect the data (continuously), **where** it's delivered (the
  dashboard's own database), and **what** the reports read (the 30-second copy).
- Result: **true 30-second data**, and much more accurate battery and charging
  analysis.

---

## Appendix — for the technical reader

For engineers, here are the real names behind the plain-language story above.

**The pipeline:** Intellicar/Polar API → poller (Python) → Postgres tables → CRM
analytics → `/ceo/intellicar` dashboards & exports.

**Root causes**

- The live loop polled **`getlatestcan` / `getlastgpsstatus`** (single-snapshot
  endpoints) every 30 s. They return only the newest cached frame, so polling faster
  just re-inserted the same frame — measured ~84% duplicate rows in `telemetry_can`,
  ~63% in `telemetry_gps`.
- The full-resolution **`getbatterymetricshistory`** endpoint (real 30 s battery data)
  ran only in the **daily backfill** (`poll_daily`, 01:05 UTC), so `telemetry_battery`
  was up to 24 h stale.
- The **Charging Analysis** export and charging-cycle dashboard read from
  **`telemetry_can`** (the ~100-rows/day snapshot), so even correct 30 s data in
  `telemetry_battery` wouldn't have reached them.
- There are **three databases** in play: the box's local TimescaleDB container
  (`intellicar` @ 5433, isolated), and the AWS RDS `itarang` (@ 5544 via an autossh
  tunnel) which the dashboards actually read, fed by an **off-box** poller.

**Fixes**

1. **`poll_recent`** (in `iot_stack/poller/poll.py`): pulls `getbatterymetricshistory`
   on a rolling window every ~5 min, per-vehicle high-water-mark, so `telemetry_battery`
   carries continuous 30 s data. (GPS stays on the live snapshot because
   `getgpshistory` returns empty on this account.)
2. **`itarang_battery_sidecar`** (a battery-only container, versioned in
   `iot_stack/battery-sidecar/`): writes the 30 s `telemetry_battery` straight into the
   production RDS `itarang` that the dashboards read — battery-only, so it can't
   conflict with the off-box poller that owns gps/can.
3. **`charging-sql.ts`**: parameterised the shared `sampleCTEs` source; charging now
   reads `telemetry_battery` (30 s) instead of `telemetry_can`. The nameplate
   (`rated_capacity`) is still read from the CAN payload. Every downstream CTE is
   byte-identical, so the physics is unchanged — only the resolution improved.

**Known follow-ups**

- Historical `telemetry_battery.pack_voltage` is `NULL`: the poller's
  `_insert_battery_rows` reads `voltage`/`packvoltage` but the API field is
  `battery_voltage`. The sidecar maps it correctly for new data; a poller fix + a
  re-backfill would fill the history. Voltage is display-only, so AH/capacity are
  unaffected.
- Discharge/mileage still read `telemetry_can`; moving them to `telemetry_battery`
  is a separate, verifiable change.
- The long-term fix is running `poll_recent` on the off-box poller that feeds the RDS,
  then retiring the sidecar.
