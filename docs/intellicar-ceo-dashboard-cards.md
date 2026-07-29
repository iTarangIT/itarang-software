# Intellicar CEO Dashboard — every card, explained

A card-by-card reference for `/ceo/intellicar`. For each card: **what it represents**, **the
exact formula**, **where the data comes from**, **which code computes it**, and **the caveat**
that governs how far it can be trusted.

This page is the index. [`intellicar-calculations.md`](./intellicar-calculations.md) is the
maths, and it stays the source of truth — every entry here links to the `§` that owns its
derivation rather than restating it, so the two cannot drift into competing answers.

**The dashboard has 24 stat cards and 12 chart cards**, spread across 7 tabs and 6 sub-tabs.
No single screen shows all of them; the table below is the map.

| Tab | Stat cards | Chart cards |
|---|---|---|
| 1. Fleet Overview | 8 | — |
| 2. Battery Analytics | 13 (5 headline + 3 usage + 5 red flags) | 12 + the location map |
| 3. Fleet Activity | 3 | — |
| 4. Health & Analytics | — | 2 charts + 1 table |
| 5. Alerts & Rules · 6. Device Management · 7. Database Health | — | — |

The 24 counts the KPI/stat tiles. The Location sub-tab's map panel carries **4 more place
cards** (Home / Parking / Charging / Overnight); they are described under 2.4 but kept out of
the 24 because they are part of the map panel rather than a stat row. Everything on screen is
covered somewhere on this page — nothing was skipped.

---

## Where the data comes from

Two databases, **not federated** — any join between them happens in the Node process.

**IoT telemetry DB** (read-only, written by the `iot_stack` Python poller on AWS), reached via
`getIotSql()`:

| Table | Carries | Feeds |
|---|---|---|
| `vehicle_state` | one live row per vehicle: SOC, SOH, GPS, `online`, `last_battery_at` | all 8 Fleet Overview cards, Fleet Devices table |
| `telemetry_can` | JSONB battery frames: SOC, pack current, voltage, temperature, rated capacity | every Battery Analytics card and chart |
| `telemetry_gps` | position fixes: lat/lon, speed, heading, ignition | location map, per-cycle distance |
| `distance_rollup` | daily km per vehicle (`bucket_size='day'`) | Avg Daily Distance, Fleet Activity, Kilometre Trend, mileage |
| `alerts` | poller-raised alerts | Active Alerts |
| `trips` | **empty fleet-wide** — the segmentation job has never run | nothing (see Fleet Activity) |

**CRM RDS** (Drizzle), for CRM-side annotation the telemetry DB does not have:

| Table | Carries |
|---|---|
| `device_battery_map` | vehicle → dealer / customer / State / City / `battery_model` |
| `battery_spec_models` | per-pack-model voltage, current, temperature and mileage limits (E-190/E-201) |
| `app_settings` | fleet-wide threshold overrides (key `intellicar_battery_thresholds`) |

Two properties of the feed shape almost every caveat on this page, and both are counter-intuitive:

- **Pack current is an unsigned magnitude.** It cannot tell you the pack is charging; rising
  SOC is the only charge signal (§1).
- **The poller stores ~100 samples/battery/day against a device that streams every ~30 s**, and
  re-inserts duplicate timestamps — up to 96% of rows on some windows. Every query dedupes with
  `DISTINCT ON (time)` first (§1). This is the root cause behind most "lower bound" labels below.

---

# 1. Fleet Overview — 8 cards

`src/components/intellicar/FleetOverview.tsx` → `GET /api/telemetry/fleet/dashboard` →
`fetchFleetDashboardCEO()` in `src/lib/telemetry/queries.ts:64`.

**Scope.** Whole fleet by default. The State / City dropdowns resolve a vehicle-number set from
CRM `device_battery_map` (`vehicleNumbersByLocation`), and every query is then scoped to that set.
An empty match zeroes the cards rather than silently showing the whole fleet.

**Refresh.** Every 60 s. If the IoT DB is unreachable the tab shows an amber banner and zeroed
KPIs — with `avgSOH` / `warrantyAtRisk` as `null`, never `0`, because the request that failed to
ask cannot report "no batteries at risk".

### 1.1 Fleet Size
**Shows** how many vehicles telemetry knows about, after the State/City filter.
**Formula** `count(*) FROM vehicle_state`
**Source** IoT `vehicle_state` · filter set from CRM `device_battery_map`
**Code** `queries.ts:80`
**Caveat** counts rows in `vehicle_state` — a device that has never reported is *absent*, not
counted as offline. Under a State/City filter it counts only vehicles that CRM has mapped to a
location, so an unmapped vehicle disappears from the filtered view entirely.

### 1.2 Utilization %
**Shows** the share of the fleet currently reporting.
**Formula** `round(active_now ÷ fleet_size × 100)` where `active_now = count(*) FILTER (WHERE online)`
**Source** IoT `vehicle_state.online`
**Code** `queries.ts:81, 121-124`
**Caveat** `online` is set upstream by the poller, not computed here — it means "the device is
reporting", **not** "the vehicle is being driven". A parked e-rickshaw with a live tracker counts
as utilised. `fleet_size = 0` yields 0, not a division error.

### 1.3 Avg SOH %
**Shows** the fleet's average State of Health, **when the BMS feed is actually measuring one**.
**Formula** `round(avg(soh_pct), 1)` — see 1.9 for when this is withheld
**Source** IoT `vehicle_state.soh_pct`
**Code** `queries.ts:82, 142`
**Caveat** on this fleet the card currently reads **`—`**, not a number. See 1.9.

### 1.4 Warranty At-Risk
**Shows** packs whose reported SOH has fallen below the 80% warranty line.
**Formula** `count(*) FILTER (WHERE soh_pct IS NOT NULL AND soh_pct < 80)`
**Source** IoT `vehicle_state.soh_pct`
**Code** `queries.ts:83, 143`
**Caveat** packs reporting **no** SOH are excluded from the count — they are *unmeasured*, not
healthy. Currently reads `—`; see 1.9.

### 1.5 Active Alerts
**Shows** open alerts across the filtered fleet.
**Formula** `count(*) FROM alerts WHERE resolved_at IS NULL`
**Source** IoT `alerts`
**Code** `queries.ts:95-99`
**Caveat** these are **poller-raised** alerts. The thresholds on the Battery Analytics tab
(§17, §24) colour *this dashboard* and have no effect on what the poller fires — the Intellicar
alert-config endpoints are dead (`fetchAlertConfig()` returns `[]`). Changing a threshold here
will not change this number.

### 1.6 Fleet Uptime
**Shows** the same number as Utilization %.
**Formula** `serviceMetrics.fleetUptime = utilization` — literally assigned, not recomputed
**Code** `queries.ts:149`
**Caveat** **this is a duplicate.** Two cards on one screen showing one measurement under two
names. It is not a second, independent uptime figure, and it should not be read as one.

### 1.7 Avg Daily Distance
**Shows** the average kilometres a vehicle covers in a day, over the last week.
**Formula** `round(avg(distance_km), 1)` over `distance_rollup WHERE bucket_size = 'day' AND time > now() - interval '7 days'`
**Source** IoT `distance_rollup`
**Code** `queries.ts:106-119`
**Caveat** this averages **rows**, not vehicles — a vehicle with a distance row every day
contributes seven values, one that reported twice contributes two. Days where the aggregator
wrote nothing are absent, not zero, so the average is over *observed* days only. `bucket_size='day'`
is pinned deliberately; any other bucket size would dilute it.

### 1.8 Offline Devices
**Shows** vehicles not currently reporting.
**Formula** `fleetSize − activeNow`
**Code** `queries.ts:151`
**Caveat** the complement of Utilization %, so it carries the same meaning of `online` — it counts
devices that have gone quiet, and cannot distinguish a dead tracker from a vehicle out of coverage.
A device whose GPS reports but whose BMS is silent counts as **online here** but shows
**Battery Offline** in the Fleet Devices table below (see 1.10).

### 1.9 Why Avg SOH % and Warranty At-Risk read "—"

Both cards are **withheld** — rendered as a grey `—` with an explanatory note — when the BMS SOH
feed is not measuring anything. The rule lives in `src/lib/telemetry/soh-math.ts`:

```
constantFeed = (packs reporting an SOH > 0)  AND  (count of DISTINCT soh values == 1)
```

The SQL collects `array_agg(DISTINCT round(soh_pct,1)) FILTER (WHERE soh_pct IS NOT NULL)`
(`queries.ts:89`), and `assessWarrantyFeed()` decides. On this fleet **all 297 reporting packs
return exactly 100.0** (13 report nothing at all), so:

- `avg(soh_pct)` is 100 **by construction** — it restates the stuck value, it does not describe
  the fleet.
- `soh_pct < 80` can never fire, so "0 at-risk" is 0 **by construction** too.

A card reading `100%` / `0` is read as a measurement. There is no way to render those numbers
honestly, so both are withheld and the card face states the reason: *"BMS SOH is stuck at 100% on
all 297 reporting packs — not a measurement."*

The detection is deliberate rather than hardcoded: **the day the poller starts writing real
values, both cards light up with no code change.** Measured capacity — the number that actually
works — is per battery, on the Battery Analytics tab (§5).

### 1.10 Below the cards: Fleet Devices status

Not a card, but it is the thing most often misread against Offline Devices. Status is
first-match-wins (§9):

```
1. open_alert_count > 0                                    → Critical
2. NOT online                                              → Offline
3. last_battery_at NULL / older than 24 h, or SOC/SOH NULL → Battery Offline (disconnected)
4. otherwise                                               → Healthy
```

So **Healthy** means: device online, no open alerts, *and* fresh SOC + SOH inside 24 hours. A
tracker reporting GPS with a silent BMS is **Battery Offline**, and it is counted as *online* by
Utilization %. Colour thresholds: SOC `>50` green / `>20` amber / else red; SOH `>80` / `>60`
(§11).

---

# 2. Battery Analytics — 13 stat cards + 12 charts

`src/components/intellicar/battery/BatteryAnalytics.tsx`. Everything on this tab is scoped to
**one selected battery** and **one period** (1 / 3 / 6 months, a calendar month, or a custom
range). Nothing renders until a battery is picked.

Only the endpoints the active sub-tab needs are fetched (`NEEDS`, `BatteryAnalytics.tsx:109`),
and each polls every 30 s.

**The cadence line under the headline cards is not a card** — it is the honest counter to
"refreshes every 30 s". It reads the real stored-sample spacing for this battery over this
window (`/api/telemetry/analytics/cadence`) and says so: *stored telemetry ~8.5 min apart
(median), ~100/day*. Polling faster than the poller writes does not raise resolution.

## 2.1 Headline cards (5)

`BatteryStatCards.tsx` → `GET /api/telemetry/analytics/ah-trend` → `fetchBatteryAhAnalytics()`
(`queries.ts:788`). Every one of these counts **charging cycles**, detected from rising SOC —
see §2 for the detection rule and §2a for how the count is verified against an independent
limb scan (62 ground-truth charges, 62 counted on the reference battery).

### Charging Cycles
**Shows** how many charges were detected in the period.
**Formula** count of cycles surviving the §2 validity gates: `end SOC > start SOC` **and**
`Ah charged > 0` **and** ≥ 1 sample carrying current **and** `duration ≥ 300 s`
**Source** IoT `telemetry_can` → `cycleCTEs()` in `charging-sql.ts`
**Code** `queries.ts:821`
**Caveat** **a small charge is still a charge** — there is no minimum SOC gain and no minimum
sample count. Both used to exist and both were wrong: the `samples ≥ 5` floor alone cost a 70%
under-count (16 reported against 62 real). Sparse sampling now downgrades a cycle's *capacity
confidence*, it never deletes the cycle. The card's hint reconciles this count against the
smaller number of cycles that yield a capacity estimate.

### Total AH Charged
**Shows** total amp-hours pushed into the pack across every detected cycle.
**Formula** `Σ over cycles of Σ over intervals: (|I(prev)| + |I(now)|)/2 × (dt/3600)` — a
**trapezoidal** integral over **real elapsed time** between deduped samples (§3)
**Source** `telemetry_can` `payload->'current'->>'value'`
**Code** `queries.ts:822`
**Caveat** the cycle's *first* interval is excluded (it reaches back into pre-plug-in idle);
the rest tile the cycle exactly. Interior zero-current pauses stay inside the cycle and
contribute nothing. Current readings above 500 A are dropped as decode faults on a pack that
peaks near 57 A. Do **not** reconcile this against `docs/intellicar/CAN Data.xlsx` — the vendor
sheet integrates a nominal 30 s interval and accounts for only 18.7% of the elapsed time (§5a).

### Avg AH / Session
**Shows** the mean charge size.
**Formula** `mean(ah_charged)` over all detected cycles — i.e. `Total AH Charged ÷ Charging Cycles`
**Code** `queries.ts:851`
**Caveat** depends on **charging habits, not battery health**: a driver who tops up from 80%
lowers this without anything being wrong with the pack. For health, read Avg Capacity.

### Avg Capacity
**Shows** the pack's measured usable capacity, extrapolated from its charges — the real
State-of-Health number, and the one that works where the BMS SOH feed does not (1.9).
**Formula** per cycle, `estimated capacity (Ah) = Ah charged ÷ (ΔSOC / 100)`; the card averages
**only the `high`-confidence estimates**
**Code** `queries.ts:831-834, 853` · grades in `charging-math.ts`
**Caveat** this is the one card whose denominator is smaller than the cycle count, and the hint
says so (*"over N plotted cycles"*). A capacity is computed for **every** cycle whose SOC rose —
nothing is withheld — but averaging in a cycle extrapolated from a 2% swing (which multiplies
its Ah error ×50) would pour noise into the one number that is supposed to beat noise down.
Grades (§5):

| Grade | Requires |
|---|---|
| **high** | ΔSOC ≥ 20 **and** coverage ≥ 15% **and** samples ≥ 5 |
| **medium** | ΔSOC ≥ 10 **and** coverage ≥ 7.5% **and** samples ≥ 3 |
| **low** | anything else |

A cycle is only as good as its worst evidence, so `high` needs all three. Reads `N/A` when no
cycle in the period graded `high`. On the reference battery: 64 cycles — 12 high, 14 medium,
38 low; the high-confidence mean is **106.0 Ah against a 105 Ah nameplate**.

### Avg Duration
**Shows** the mean length of a charge, in minutes.
**Formula** `mean(duration_s) ÷ 60`, where a cycle runs from the last sample *before* SOC first
rose to the last sample where SOC still rose (§2)
**Code** `queries.ts:854-855`
**Caveat** the end anchor deliberately keeps the CV taper (current falling as SOC reaches 100)
inside the cycle while leaving out the flat 100% idle that follows. A charge split by a >2 h
telemetry gap is counted as two shorter cycles.

> **Note — a sixth summary figure exists but is not shown.** `summary.avgSocGained`
> (`queries.ts:856`) is computed and returned by the API, and `intellicar-calculations.md` §7
> lists "Avg SOC Gained" as a summary card, but `BatteryStatCards.tsx` renders only the five
> above. See §6 below.

## 2.2 Usage & Distance cards (3)

`DriverBehaviourCards.tsx` → `GET /api/telemetry/analytics/distance-trend`
(`battery-queries.ts:349-378`). Driver behaviour at a glance: how far, how often, how much per
working day.

### Total Kilometres
**Shows** distance driven in the period.
**Formula** `Σ km` over buckets that **have** a distance row
**Source** IoT `distance_rollup`, `bucket_size='day'`
**Code** `battery-queries.ts:350`
**Caveat** **a lower bound whenever any bucket lacks a distance row**, and the card's hint
switches to say so. A missing row is *unknown*, not zero — the aggregator lives in `iot_stack`
and has gaps, and coalescing them to 0 would assert "parked" on a day nobody measured (§15).

### Active Days
**Shows** days the battery actually did work.
**Formula** `count(days with a distance row AND km > 0)`
**Code** `battery-queries.ts:353, 374`
**Caveat** **day-grained regardless of the chart's granularity** — a week bucket containing one
working day must not read as one active week, which is what makes this comparable across a
1/3/6/12-month selection.

### Avg KM / Active Day
**Shows** how hard the vehicle works on the days it works.
**Formula** `Total Kilometres ÷ Active Days`
**Code** `battery-queries.ts:375-377`
**Caveat** inherits Total Kilometres' lower-bound status. Distinct from Fleet Overview's Avg
Daily Distance, which averages across all rollup rows fleet-wide over 7 days rather than one
battery's working days.

## 2.3 Electrical red flags (5)

`RedFlagCards` in `charts/ElectricalCharts.tsx:321` → `GET /api/telemetry/analytics/electrical-trend`.
Thresholds resolve **per battery**: model spec (`battery_spec_models` via
`device_battery_map.battery_model`) > `app_settings` > env > hardcoded default (§24). The
defaults — 44 V, 60 V, 70 A, 55 °C — are sized to what this fleet's telemetry shows, **not from
a cell spec sheet**.

### Under Voltage · Over Voltage · Over Current
**Show** stored samples that breached the limit.
**Formula** `count(*) FILTER (WHERE pack_voltage < underVoltageV)` / `> overVoltageV` /
`WHERE ABS(pack_current) > overCurrentA`, over deduped `telemetry_can` samples
**Code** `battery-queries.ts:654-656`
**Caveat** **these are floors, not counts, and the card face says so** — the value carries the
word *observed*. A real electrical transient lasts seconds; this battery is sampled every ~8.5
minutes, so roughly **1% of them are caught**. **A reading of 0 means we did not catch one, not
that none occurred.** The panel quotes *this battery's* measured cadence rather than a constant,
because the poller's spacing differs per vehicle and drifts. Fixing this needs a BMS-side alert
in `iot_stack`, which sees every frame — no amount of query work in the CRM can reconstruct a
transient from 1% of the data (§17).

### Over Temperature
**Shows** samples above the temperature limit.
**Formula** `count(*) FILTER (WHERE pack_temp_c > overTemperatureC)` from
`payload->'battery_temp'->>'value'`
**Code** `battery-queries.ts:657`
**Caveat** **trustworthy, and the only instantaneous flag here that is.** Thermal mass moves on
a *minutes* timescale, so a thermal event is genuinely observable at this cadence. It carries no
"observed" qualifier for exactly that reason.

### Weak Charge
**Shows** charges that ran at an abnormally low current — a failing charger or a
high-resistance connection.
**Formula** `count of charging cycles where avg_charging_current < weakChargeCurrentA`
**Code** `battery-queries.ts:696-697`
**Caveat** **trustworthy.** This is the redefinition of "under current" that makes it useful: a
naive threshold on instantaneous current fires on every parked vehicle and counts parked hours
as faults. Scoping it to the average across a whole detected charging cycle is what turns a
meaningless reading into an actionable one. It reuses the authoritative charge aggregate, so it
cannot disagree with the Charging Cycles card. `weakChargeCurrentA` stays **fleet-wide** even
when a spec model is mapped — it describes how this dashboard judges, not what a pack is rated
for (§24).

## 2.4 The 12 charts

Each is a card with a title, a headline figure, the plot, and a caveat block. Grouped by
sub-tab.

### Capacity & Health

**1 · Capacity Degradation** — `CapacityDegradationChart.tsx`
Estimated capacity (Ah) per charging cycle against the pack's own nameplate. **Plots capacity,
not Ah charged, despite still being called "AH Trend" in the code and in §6** — Ah charged tracks
charging habits, capacity normalises that out, so a decline here means real degradation.
One continuous line through every cycle; **filled marker = `high` confidence, hollow = thin
evidence, caret = value clamped to the axis edge** (a cycle reading 1,199 Ah on a 105 Ah pack is
a fault worth seeing, so it is clamped, never dropped). Zone washes with labelled dashed rules at
`0.90 × rated` (warning) and `0.80 × rated` (critical) — fractions, so they generalise to a pack
of any rating; **a pack reporting no nameplate gets no bands** (§18). The y-axis is scaled to the
*plausible* points only (0.3×–1.5× of nameplate).
**Trust: Medium** — ±15% scatter is sampling noise. Good for spotting a pack well below nameplate
or wildly erratic; **cannot resolve 1–2%/yr degradation**, and no threshold change will fix that
(§6).

**2 · Capacity by Period** — `CapacityByPeriodChart.tsx`
Mean estimated capacity per month, with the **interquartile range** of the cycles behind it as a
band. Averages **`high`-confidence cycles only**, from the same payload the chart above draws, so
the two can never disagree. Averaging beats the per-cycle noise down by roughly √n, which is what
makes a trend readable at all. The band is the reason to trust or distrust each mean — a month
whose cycles disagree wildly gets a fat one — and `n` is in the tooltip because a mean of two
cycles is not a mean.
**Trust: Medium.**

### Energy

**3 · Monthly Charge, Discharge & Distance** — `EnergyCharts.tsx:53`
Per month: Ah **in** (bar), Ah **out** (bar), km driven (dotted line, right axis). **The one
dual-axis chart on the tab**, with load-bearing mitigations: different mark types so heights are
never compared across axes, each axis labelled with its unit, right-axis ticks tinted the line's
colour, and the legend naming the axis. Months with no rollup distance **break the line**
(unknown ≠ zero); months with no detected cycle show zero-height bars, which is what "no detected
cycle" honestly measures.
**Trust: High** — the charge and discharge totals are two independent measurements agreeing
within 25% on the reference battery (§13).

**4 · Deep Discharge Events (below 20% SOC)** — `EnergyCharts.tsx:233`
One point per month: the count of times the pack was run flat. Detected by a **Schmitt trigger**,
not a threshold — enter below `20%`, leave at `25%`, state carried in between (§14). The 5-point
hysteresis band is what makes one physical event one row: a bare `SOC < 20` filter counts a
battery hovering at 19–21% as a new event on every wobble. On the reference battery **163 samples
below 20% debounce to 30 physical events** — the naive count is 5× the truth. A series opening
*inside* the band has no prior state and is given none rather than guessing one.
**Trust: High** — SOC is a state, and the trigger is exact.

### Usage & Distance

**5 · Kilometre Trend** — `DistanceCharts.tsx:107`
Distance per period, as bars, from `distance_rollup`. **A bucket with no distance row renders as
a gap, never a zero-height bar** — the tooltip says *"No distance row — unknown, not zero."*
One y-axis, as every chart on this tab except #3.
**Trust: High** — measured distance, gaps shown as gaps.

**6 · Discharge vs Kilometres** — `DistanceCharts.tsx:211`
Scatter, one point per **discharge cycle**: x = km covered inside that cycle's window, y = Ah
drawn. Slope = the pack's Ah/km; the dashed reference is the pack average, and points above it did
more work per kilometre. The headline is the **aggregate** ratio (Σ Ah ÷ Σ km), not the mean of
per-cycle ratios — a partially-resolved cycle must not count as much as a full one.
Per-cycle distance is the **GPS chord calibrated against the daily rollup** (§21): the chord gives
the cycle its share of the day, the rollup gives the day its true scale. Cycles moving under 1 km
are parked drains and are counted in the caveat rather than plotted at the axis; uncalibrated
points are labelled a lower bound.
**Trust: Medium** — daily attribution only.

**7 · Current vs Mileage** — `DistanceCharts.tsx:697`
Scatter, one point per discharge cycle: x = km/Ah (right = more efficient), y = **average
discharge current** (the sustained load). **High and to the left is the overload signature.**
Orange = this cycle's average current is ≥ `currentLoadIndexWarn` × *this pack's own median*
draw — colour is the own-normal index, never the rated limit, because a sustained average almost
never reaches a peak-protection ceiling. The amber line is the rated over-current, shown for
scale only.
**Caveat carried on the card:** the axes share a tendency — km/Ah ≈ speed ÷ current — so some of
the rise to the left is arithmetic, not a finding. It is honest here because each point is one
cycle and the mileage's Ah is SOC-derived (a different measurement from the current samples, so
the axes are not an identity).

**8 · Mileage Trend** — `DistanceCharts.tsx:380`
km per Ah, **one point per day**. `daily mileage = rollup_km[day] ÷ SOC-derived Ah discharged
that day`; the dashed reference is `Σ km ÷ Σ Ah` over the window. km/Ah is the driver's-eye
reading of Ah/km — bigger is better, like fuel economy — and needs no voltage assumption, which
is why it was chosen over km/kWh (§22).
**Daily and rollup-based on purpose:** "instantaneous" mileage from speed ÷ current would sample
two feeds on independent clocks at ~8.5 min — aliasing dressed as a signal. Only days with
**both** a distance row and a resolved discharge appear; the rest are absent, not zero, and the
line skips them. E-201 adds the model spec's normal km/Ah band as red-floor / green-ceiling
dashed rules, drawn only when the spec records one.
**How to read it:** points well below the pack average did little distance for their charge —
overload, heavy draw, misuse. A sustained slide of the line is a mileage drop.

**9 · Per-Cycle Mileage** — `DistanceCharts.tsx:510`
km per Ah, **one point per discharge cycle**, plotted at the time it happened — the finest honest
grain, and the closest this data supports to an "instantaneous" mileage chart. Where #8 answers
*how did mileage move day to day*, this answers *which individual trips were inefficient*: one
overloaded run shows as its own low dot instead of being averaged into its day. Split by colour
at the pack average, with a legend naming both series. Same aggregate pack average as #6, so the
two per-cycle views quote one number.

### Location

**Location map** — `LocationMap.tsx` (a map panel, not one of the 12 charts)
Two switchable heat layers over OpenStreetMap, plus four numbered place cards.
**The kilometre heat map is weighted by distance travelled through each ~111 m cell, not by fix
count** — a point-density map lights up brightest where the vehicle sat *longest*, i.e. travelled
*least*, and a reader takes that blob for "the busy route" when it means "the car park".
Weighting by distance makes roads glow and the car park go dark. "Time spent" is the opposite
question and gets its own layer. Intensity is normalised against this battery's own busiest cell.
**Dwell is found by position, not speed** — only 0.7% of fixes on this fleet report a clean zero,
so `displacement < 100 m` is dwell and `≥ 30 m` is travel; the move floor exists because without
it GPS noise mints ~3.6 km/day of phantom travel (§20).
The four cards: **1 Home** (most night-hours, 22:00–05:00 IST, across ≥1 night), **2 Parking**
(most total stationary hours), **3 Charging** (most stationary time *inside detected charge
windows*, requiring ≥2 distinct sessions), **4 Overnight (secondary)** (runner-up night cluster).
Roles landing on one cell render as a single pin carrying every number.
**Caveats:** the overnight location is an **inference, not an address** — it is not
reverse-geocoded, and runner-up clusters are shown beside it because the ranking is often close.
Dwell hours across gaps longer than 6 h are **inferred, not observed**, and the panel states what
share of the total that is. GPS chord distance is a **27% lower bound** by construction and is
named `gpsChordKm` to keep it from being quoted as a distance total.

### Electrical

**10 · Voltage Trend** · **11 · Current Trend** — `ElectricalCharts.tsx:189, 250`
Per bucket: a **min–max envelope with a median line**. **Never a raw per-sample line, and this is
not a style preference** (§16). Voltage and current move on a ~1-second timescale; we sample every
~8.5 minutes. A line through those points is an *aliased* signal — it looks like a waveform and
invites the reader to see spikes that are artefacts of when the poller happened to look. The
envelope states exactly what is known: the range the value occupied, and where its middle sat.
Threshold rules from the resolved per-battery limits (§24). Voltage's y-axis is tightened to the
observed band ±2 V so breach lines clip until the pack drifts toward them — which is precisely
when they carry information. **Current is an unsigned magnitude**, so the chart shows the *size*
of the current, never its direction; its median sits near zero because the pack idles most of the
time, and **the upper edge of the band is the number that matters** — it is what the pack was
asked to deliver.
**Trust: Low-ish** — honest about its range, blind between samples.

### Timeline

**12 · Charging Timeline** — `ChargingTimeline.tsx`
SOC over time, with detected charge segments shaded green and discharge segments orange.
**This is the chart that makes cycle detection falsifiable by eye**: every rising limb should be
green, every fall orange, nothing important left bare. The bands come from the *same aggregates
that feed the cards* — charge bands from the timeline's server-side `in_cycle` flag, discharge
bands from the discharge cycles' start/end times — so **a band cannot disagree with a card**
(it once could: the chart used to shade runs the cards had thrown away).
Click a band to open that cycle's **full record** beneath the chart (not in a modal, which would
cover the shape you are reading the detail against): duration, SOC swing, Ah, avg/peak current,
estimated capacity, coverage, sample count — and for discharge cycles, distance covered, mileage,
both Ah figures and their divergence. Expandable; drag the brush to zoom.

## 2.5 Two Ah figures on discharge, and which to believe

The timeline's discharge detail shows **Discharged (from SOC)** and **Discharged (coulomb)**.
They are two independent routes to one quantity (§13):

```
SOC-derived (PRIMARY)  Ah = (startSOC − endSOC) / 100 × ratedCapacity
Coulomb     (CHECK)    Ah = ∫|I| dt , over falling intervals only
```

**The SOC figure is the primary series everywhere** — SOC is a *state*, so it needs only the two
endpoints and does not degrade as the poller gets sparser. Discharge current swings 0–57 A with
traffic, so interpolating it across a 33-minute gap is a straight line drawn through a curve
nobody saw. **The divergence between them is the confidence signal** (median 20% on the reference
battery); a cycle with fewer than 5 samples carries no coulomb figure at all. Per-cycle mileage
always divides by the **SOC-derived** figure.

---

# 3. Fleet Activity — 3 cards

`TripAnalytics.tsx` → `GET /api/telemetry/trips/overview` → `fetchVehicleActivity()`
(`queries.ts:1235`). All three come from one aggregate over
`distance_rollup WHERE bucket_size = 'day' AND distance_km > 0 AND time > now() - interval '30 days'`.

### Active Vehicles
**Formula** `count(DISTINCT vehicleno)` · **Caveat** vehicles that drove but whose rollup rows
are missing do not appear; "active" here means "has a distance row", not "commissioned".

### Distance (30 days)
**Formula** `round(sum(distance_km))` · **Caveat** a fleet total, and a lower bound wherever the
aggregator has gaps.

### Avg per Vehicle-Day
**Formula** `round(avg(distance_km), 1)` · **Caveat** averaged over **rows**, so a vehicle
reporting on more days weighs more. Not `Distance ÷ Active Vehicles`.

### Why this tab shows days, not trips
The amber banner is the point. **`trips` is empty across the entire fleet** — the trip
segmentation job in `iot_stack` has never run — so start/end points, trip duration and average
speed do not exist to show. This tab used to read `trips` and render an empty table over a fleet
that had demonstrably driven 873,715 km; an empty table does not say *"the data is missing"*, it
says *"nothing happened"*. `tripsTableRows` is returned so the UI can explain itself, and **the
banner disappears on its own the day the aggregator runs** (§15).

---

# 4. Tabs with no stat cards

- **Health & Analytics** — *SOH Degradation (30 days)* line chart, *Warranty At-Risk Devices*
  table, *Dealer Comparison* bar chart. All three are governed by the same stuck-feed rule as
  1.9: when every pack reports the identical SOH, the chart and the table are **replaced by an
  explanatory notice** rather than drawn flat at 100. A panel whose query fails shows the
  server's error, never an empty state — a dead connection must never be indistinguishable from
  a healthy fleet.
- **Alerts & Rules** — alert list and acknowledgement. Note the alert-config endpoints are dead
  (§17): `fetchAlertConfig()` returns `[]` and `updateAlertConfig()` throws.
- **Device Management** — device ↔ dealer/vehicle mapping, on CRM RDS.
- **Database Health** — telemetry table sizes and ingestion status.

---

# 5. Trust summary

Read this before quoting any number off this dashboard.

| Card / chart | Trust | Why |
|---|---|---|
| Fleet Size, Utilization %, Offline Devices, Fleet Uptime | **High** | direct counts off `vehicle_state` |
| Active Alerts | **High** | direct count, but reflects *poller* thresholds, not this dashboard's |
| Avg SOH %, Warranty At-Risk | **Withheld** | BMS feed is constant — not a measurement (1.9) |
| Avg Daily Distance, Fleet Activity cards | **High**, lower bound | measured km; aggregator gaps absent, not zero |
| Charging Cycles | **High** | verified against an independent limb scan, 62/62 (§2a) |
| Total AH Charged, Avg AH / Session | **High** | trapezoidal integral over real elapsed time (§3) |
| Avg Capacity | **High for what it averages** | `high`-confidence cycles only; `N/A` when none qualify |
| Total Kilometres, Active Days, Avg KM / Active Day | **High**, lower bound | flagged on the card when buckets lack rows |
| Under/Over Voltage, Over Current | **Lower bound ONLY** | ~1% of transients caught (§17) |
| Over Temperature, Weak Charge | **High** | slow signals, genuinely observable |
| Capacity Degradation, Capacity by Period | **Medium** | ±15% sampling scatter; cannot resolve 1–2%/yr |
| Monthly Charge/Discharge/Distance | **High** | two independent methods agree within 25% |
| Deep Discharge Events | **High** | SOC is a state; the Schmitt trigger is exact |
| Kilometre Trend | **High** | measured distance, gaps shown as gaps |
| Discharge vs km, Mileage Trend, Per-Cycle Mileage, Current vs Mileage | **Medium** | daily attribution; GPS chord calibrated against the rollup |
| Voltage / Current envelopes | **Low-ish** | honest about range, blind between samples |
| Location map | **Medium** | dwell by position is sound; overnight is an inference, GPS km a 27% lower bound |

**Everything here is limited by one root cause:** the poller stores ~100 samples per battery per
day against a device that streams every ~30 s. **Fixing the poller is worth more than any further
work in this repo** — and it is Python in `iot_stack` on AWS, outside it.

---

# 6. Known discrepancies

Recorded, not silently fixed. Each needs a decision from whoever owns the surface.

1. **"Avg SOC Gained" is documented as a card but does not render.**
   `intellicar-calculations.md` §7 lists six summary cards; `BatteryStatCards.tsx:51-85` renders
   five. `summary.avgSocGained` is computed and returned (`queries.ts:856`) but nothing consumes
   it. Either add the card or drop it from §7.

2. **§10 describes an Avg SOH card the dashboard does not show.**
   It states `Avg SOH % = average of SOH across the fleet`. The live code withholds the value
   entirely on a constant feed (`queries.ts:130-143`), which is the behaviour on this fleet
   *today*, so §10 documents a number no reader will ever see. §10 should carry the withholding
   rule.

3. **The capacity chart has two names.**
   §6 and the source comments call it **AH Trend**; the rendered `<h3>` is **Capacity
   Degradation** (`CapacityDegradationChart.tsx:343`). Both are in circulation. Worth settling
   on one, since "AH Trend" actively misdescribes what it plots.

4. **Fleet Uptime and Utilization % are the same number, shown twice.**
   `serviceMetrics.fleetUptime = utilization` (`queries.ts:149`). Two cards on one screen invite
   the reader to assume two measurements. Either give uptime a real definition (e.g. share of the
   last 24 h with telemetry) or drop the card.
