# Intellicar Telemetry Fields — what the dashboard actually reads

Every CAN packet the fleet sends carries **119 fields**. The Intellicar dashboard reads **five of
them**. This doc names those five, shows the formula each one enters, records the trust caveats
that apply to each, and inventories the other 114 so you can see what is available and why we
ignore it.

This doc is a *field reference*. It deliberately does not restate the maths — cycle detection,
coulomb counting, capacity extrapolation, dwell clustering and the rest live in
[`intellicar-calculations.md`](./intellicar-calculations.md) and are cited here as **calculations §N**.
For a card-by-card walk of the UI, see
[`intellicar-ceo-dashboard-cards.md`](./intellicar-ceo-dashboard-cards.md), cited as **cards §N**.
A bare `§N` refers to a section of this doc.

---

## 1. The packet

`telemetry_can` lives on the IoT Postgres (`IOT_DATABASE_URL`, read-only role `dashboard_ro`,
client in `src/lib/db/iot.ts`). Three columns:

```
time       timestamptz   when the poller stored the frame
vehicleno  text          device identifier, e.g. TK-51105-06DZ-215008
payload    jsonb         the BMS frame — 119 keys
```

Every payload key is an object, not a scalar:

```json
"soc": { "value": 85, "timestamp": 1782345760886 }
```

So every read is a two-hop extraction — `(payload->'soc'->>'value')::float` — and never
`payload->>'soc'`. **That inner `timestamp` is per-field and is not the same as the row's `time`.**
Section 5 is mostly about the consequences of that.

Two properties of the table shape every query that touches it:

- **~96 % of rows repeat a timestamp.** The poller re-inserts the latest CAN frame on every poll
  whether or not it changed. Hence `DISTINCT ON (time)` in every read site — without it the Ah
  integral counts the same interval dozens of times (`charging-math.ts:26`).
- **The distinct stream is only ~100 rows/day**, not the device's nominal 30 s. See
  [`why-30-second-vehicle-data-explained.md`](./why-30-second-vehicle-data-explained.md) and
  `intellicar-poller-30s-escalation.md`.

---

## 2. The five fields we use

| Field | JSON path | Read at | Feeds |
|---|---|---|---|
| `soc` | `payload->'soc'->>'value'` | `charging-sql.ts:199`, `battery-queries.ts:418,426` | every discharge-cycle boundary, deep discharge, cadence, timeline |
| `current` | `payload->'current'->>'value'` | `charging-sql.ts:200,211,212` | the trapezoid Ah term, Current Trend, over-current flag |
| `battery_voltage` | `payload->'battery_voltage'->>'value'` | `charging-sql.ts:201` | Voltage Trend, under/over-voltage flags |
| `rated_capacity` | `payload->'rated_capacity'->>'value'` | `charging-sql.ts:178,181,202` | nameplate Ah — capacity bands, SOC-derived Ah |
| `battery_temp` | `payload->'battery_temp'->>'value'` | `battery-queries.ts:615,618,646,649` | temperature median/max, over-temperature flag |

Those five are the complete set. Verified by grepping every `payload->`, `payload ?` and
`Object.entries(row.payload)` read site in `src/`.

### 2.1 `soc` — state of charge, %

The load-bearing field. Everything on the CAN path keys off it.

It is both a **filter** and a **signal**: every query drops rows where it is null
(`AND payload->'soc'->>'value' IS NOT NULL`), so a frame without SOC does not exist as far as the
dashboard is concerned — which is also why the cadence readout counts SOC-bearing rows rather
than all rows.

Its first derivative drives cycle detection. `sampleCTEs()` computes
`dsoc = soc - LAG(soc) OVER (ORDER BY time)`, and the sign of `dsoc` is what separates charge from
discharge — not the current field (see §5.1). Discharge sessions are `dsoc <= 0` runs
(`discharge-sql.ts`), and Ah accrues only where `dsoc < 0`, so interior flat stretches sit inside
the cycle without contributing (calculations §12).

It is also the primary Ah source on the discharge side:
`socDerivedAh = (startSoc − endSoc)/100 × ratedAh` (`discharge-math.ts`), which is trusted over
coulomb counting given the sample cadence (calculations §13).

Deep-discharge events use a Schmitt trigger on it — enter below 20 %, exit at 25 %
(`DEEP_DISCHARGE_ENTER_PCT` / `EXIT_PCT`) — so a pack hovering at 20 % logs one event, not forty
(calculations §14).

Range in the sample: 34–100, present and live in 100/100 rows.

### 2.2 `current` — pack current, A

Feeds the trapezoid term that integrates charge:

```
ah_term = (|I_prev| + |I_now|) / 2 × (dt_s / 3600)
```

Guarded on read: frames above `MAX_VALID_CURRENT_A` (500) are rejected rather than integrated,
because a current in the hundreds on a pack that peaks near 57 A is a decode fault that would
silently inflate the Ah total. A *missing* reading is not corrupt, so it stays
(`charging-sql.ts:206-213`).

Also produces `avg_discharge_current` / `max_discharge_current` per cycle, the Current Trend
envelope (min, median, p95, max per bucket) and the over-current red-flag count.

**It is unsigned** — see §5.1 before writing anything that depends on its sign.

Range in the sample: 0–45.17 A, and exactly 0 in 78 of 100 rows (parked).

### 2.3 `battery_voltage` — pack voltage, V

Read into `pack_voltage` on the CAN path. Produces the Voltage Trend envelope
(min, p05, median, p95, max per bucket) and both voltage red-flag counts:

```
under_voltage = count(*) FILTER (WHERE pack_voltage < t.underVoltageV)
over_voltage  = count(*) FILTER (WHERE pack_voltage > t.overVoltageV)
```

The thresholds are **not hard-coded**. `getBatteryThresholds(vehicleno)` resolves them per vehicle:
battery model spec (`battery_spec_models`, E-190) → `app_settings` → env → default (44 V / 60 V).
See calculations §24 and `thresholds.ts`.

Worth noting for anyone reading the charts: **the poller writes this field to
`telemetry_battery.pack_voltage` incorrectly** — it looks for `voltage`/`packvoltage` while the API
field is `battery_voltage`, leaving the column NULL. That is why the voltage chart reads the CAN
payload rather than the battery table. Documented in `why-30-second-vehicle-data-explained.md`.

Range in the sample: 52.07–65.91 V.

### 2.4 `rated_capacity` — nameplate capacity, Ah

A per-battery constant, so it is read once as an uncorrelated scalar subquery
(`ORDER BY tc.time DESC LIMIT 1`) rather than per row — it evaluates as an InitPlan.

It is the only CAN field the **charging** path touches. Charging integrates
`telemetry_battery` columns for soc/current/voltage (the real ~30 s series), but that table has no
nameplate column, so `rated_capacity` is still fetched from `telemetry_can` (`charging-sql.ts:175-183`).

Three things depend on it:

- `socDerivedAh` — the primary discharge Ah figure (calculations §13)
- capacity bands — `warning = rated × 0.9`, `critical = rated × 0.8` (`capacityBands()`, calculations §18)
- the capacity plausibility gate — an extrapolated capacity is kept only when
  `0.3 ≤ estimated/rated ≤ 1.5`

When the CAN value is absent, `fetchDischargeAnalytics` falls back to the E-190 spec
(`getBatteryThresholds().ratedCapacityAh`) and reports which was used via
`rated_capacity_source: 'can' | 'spec'`.

Constant 105 Ah across the whole sample.

### 2.5 `battery_temp` — pack temperature, °C

The narrowest of the five: it feeds only the Electrical sub-tab — `t_med` / `t_max` per bucket and
the over-temperature breach count against `t.overTemperatureC` (default 55 °C).

It is joined rather than read inline, because it is sparser than SOC:

```
temp AS (
    SELECT DISTINCT ON (time) time, (payload->'battery_temp'->>'value')::float AS pack_temp_c
    FROM telemetry_can
    WHERE vehicleno = … AND payload->'battery_temp'->>'value' IS NOT NULL …
)
… FROM stepped s LEFT JOIN temp tp USING (time)
```

**This is the one used field that is not on the live frame** — see §5.3.

Range in the sample: 31.75–47.15 °C.

---

## 3. What the dashboard does *not* get from this table

The natural misreading of a CAN dump is that the whole dashboard comes out of it. It does not.
Most of what you see on `/ceo/intellicar` is sourced elsewhere:

| Figure | Real source |
|---|---|
| Charging Cycles, Total AH Charged, Avg AH/Session, Avg Capacity, Avg Duration | `telemetry_battery` columns (`soc_pct`, `pack_current`) — the true ~30 s series |
| Capacity Degradation, Capacity by Period, Charging Timeline (charge bands), Excel export | same — `cycleCTEs()` passes `source="battery"` (`charging-sql.ts:261`) |
| Total Kilometres, Kilometre Trend, Avg KM/Active Day, and all km in the mileage charts | `distance_rollup` where `bucket_size='day'` |
| Kilometre / Time-Spent heat map, Home, Parking, Charging, Overnight | `telemetry_gps` via haversine in `geo-sql.ts` |
| Fleet Size, Utilization, Avg SOH, Warranty At-Risk, Active Alerts, Fleet Devices | `vehicle_state` and `alerts` |
| SOH Degradation (30 Days) | `telemetry_battery.soh_pct` |
| Dealer Performance, Dealer Comparison, State/City filters | CRM RDS `device_battery_map` |

**Three tabs never touch `telemetry_can` at all:** Fleet Overview, Health & Analytics, and Device
Management. Fleet Activity reads only `distance_rollup` and `trips`.

On the Battery Analytics tab the CAN payload drives: discharge cycles, deep discharge, the
Voltage/Current/temperature series and red flags, the cadence readout, and the `has_telemetry`
flag on the distance chart (which distinguishes "no distance" from "no telemetry" so a gap is
never drawn as a zero).

---

## 4. Frame speeds — which keys you can trust at packet resolution

Each key carries its own `timestamp`. Comparing it to the row's `time` splits the 119 keys into
three groups. This is the most reusable fact in this doc: **check which group a field is in before
you build on it.**

| Frame | Share of rows where the field is fresh (<60 s) | Median lag | Keys |
|---|---|---|---|
| **Fast** | 100 % | 0 s | `soc`, `current`, `battery_voltage`, `rated_capacity`, `cell_voltage_01..24`, `maximum`/`minimum_cell_voltage`, `maximum`/`minimum_cell_temperature`, `charge_cycle`, `discharge_cycle`, `dod`, `enum`, `alarm`, `protection`, `allow_charging`, `allow_discharging`, `balancing_status`, all 34 `*_alarm`/`*_protection` flags, all identity/config keys |
| **Medium** | 2 % | ~13 h | `battery_temp`, `cell_temperature_01..12`, `charger_mode`, `current_request_cc_mode`, `voltage_request_cv_mode` |
| **Slow** | 0 % | ~2.7 days | `soh_1`, `charge_cycle_count`, `mfh`, `battery_charge`/`discharge_cummulative_capacity`, `battery_charge`/`discharge_run_hrs`, `cummulative_charge`/`discharge_energy`, all 7 `*_occurence_count` / `*_occurance_count` |

Four of the five used fields are on the fast frame. `battery_temp` is on the medium frame (§5.3).

---

## 5. Gotchas

Each item below is measured from the sample and cross-checked against the code. Read the appendix
on how far the sample can be pushed.

### 5.1 `current` is unsigned — direction comes from SOC, not from the field

**0 of 100 rows carry a negative current.** The field is a magnitude; charge and discharge look
identical in it.

The code is already correct about this — `charging-sql.ts:120` documents `pack_current` as
"unsigned magnitude", the trapezoid takes `ABS()`, and direction is derived from `dsoc`
throughout. It is called out here because two idioms in the SQL *read* like sign tests and are not:

```
avg(pack_current) FILTER (WHERE pack_current > 0)   -- "is not idle", not "is charging"
count(*) FILTER (WHERE ABS(pack_current) > …)       -- the ABS() is a no-op on this feed
```

Anyone adding a query must take direction from `dsoc` (or `enum`, §5.2). Taking it from the sign
of `current` will silently return zero rows.

### 5.2 `enum` is an unused direction flag that tracks current exactly

| `enum` | Rows | `current` |
|---|---|---|
| 0 | 78 | exactly 0 in all 78 |
| 1 | 21 | 1.05–45.17 A |
| 2 | 1 | 20.87 A |

It is on the fast frame, present in 100/100 rows, and no query reads it. It is the most obvious
candidate for corroborating the SOC-derived direction — particularly for the flat stretches inside
a cycle, where `dsoc = 0` tells you nothing but `enum` distinguishes idle from active. Worth
confirming the encoding with the vendor before relying on it; three observed values in one sample
is not a spec.

### 5.3 `battery_temp` is carried forward; a live alternative sits unread

**Only 2 % of rows carry a `battery_temp` whose own timestamp is within 60 s of the row time.**
Median lag ≈ 13 hours. Meanwhile `maximum_cell_temperature` and `minimum_cell_temperature` are
**100 % live**, present in all 100 rows, and unread.

The effect is visible within a single row: `battery_temp` reads 41.05 °C while the live
`maximum_cell_temperature` in the same frame reads 39.75 °C — the used field is *higher than the
live maximum* because it is a stale carry-forward.

So `t_med` / `t_max` and the over-temperature breach count rest on a value that may be hours old.
The direction of the error is not fixed — a carried-forward reading can sit above or below the
truth — so this is not "the counts are too low", it is "the counts are unanchored".

`maximum_cell_temperature` is the natural replacement for a "hottest point in the pack" metric.
**Treat this as a candidate, not a settled defect:** it rests on one 3-hour window, and the medium
frame may simply be how this BMS reports pack temperature, in which case the fix is to label the
chart's resolution rather than change the field.

### 5.4 `soh` is pinned at 100; the unused `soh_1` actually varies

`soh` reads exactly **100 in all 100 rows**. `soh_1` — which nothing reads — ranges **97–100**
across 77 rows.

This is consistent with, and the likely upstream cause of, the constant-SOH condition the
dashboard already detects: `classifySohFeed()` in `soh-math.ts` spots that every `soh_pct` collapses
to a single value and **withholds** Avg SOH and Warranty At-Risk rather than printing a fake 100 %.
That rule is documented in [`intellicar-ceo-dashboard-cards.md`](./intellicar-ceo-dashboard-cards.md)
cards §1.9 — note that calculations §10 still describes an Avg SOH card the dashboard does not
currently show. The derived columns `vehicle_state.soh_pct` and `telemetry_battery.soh_pct` come
from the same BMS source.

So `soh_1` is the first place to look for a real SOH signal. Two caveats before anyone acts on it:
it is on the **slow frame** (0 % live, median lag ~2.7 days), and a 97–100 spread across a mixed
fleet is a narrow band that may be quantisation rather than genuine degradation. Verify against a
full extract spanning months.

### 5.5 `-273.15` is the absent-sensor sentinel

**65 % of all `cell_temperature_01..12` readings are exactly `-273.15`** — absolute zero, the
BMS's "no sensor here" marker. `cell_temperature_06..12` are `-273.15` in every row of the sample,
while `no_of_temperature_sensors` reports 1–5 and 12 slots are transmitted regardless.

Nothing reads these today. If anything ever does, it must filter the sentinel — a naive
`AVG()` over the twelve slots returns roughly −150 °C.

The same shape applies to `cell_voltage_*`: slots 17–24 read 0 on 16-cell packs (`no_of_cells` is
16–20 in the sample), so an average over all 24 understates pack cell voltage by a third.

### 5.6 Fields that never vary

Constant across the entire sample, so nothing can be inferred from them without re-checking on a
wider extract: `dod` (100), `mfh` (0), `cummulative_charge_energy` (0),
`cummulative_discharge_energy` (0), `battery_discharge_run_hrs` (0), `protection` (0),
`chemistry` (1), `charger_mode` (1), `iot_no` (0), and all 34 alarm/protection flags (0 — no
vehicle in the window had a fault).

`cummulative_charge_energy` / `cummulative_discharge_energy` are the notable ones: they read as
kWh totals and would be an attractive cross-check on coulomb counting, but they are pinned at zero
while their Ah-denominated siblings (`battery_charge_cummulative_capacity`, 87–22762) do carry
data. Use the capacity pair, not the energy pair.

### 5.7 Misspelled duplicate keys

The feed carries both spellings of four flags:

| Misspelled ("volatge") | Rows | Correct | Rows |
|---|---|---|---|
| `cell_under_volatge_alarm` | 1 | `cell_under_voltage_alarm` | 99 |
| `cell_under_volatge_protection` | 1 | `cell_under_voltage_protection` | 99 |
| `pack_over_volatge_alarm` | 1 | `pack_over_voltage_alarms` | 99 |
| `pack_under_volatge_alarm` | 1 | `pack_under_voltage_alarms` | 99 |

Note also the singular/plural split on the `pack_*` pair. Any consumer matching these by name must
handle both spellings or it will silently miss the frames that use the other one. Firmware version
is constant in this sample, so the split is likely per-device rather than per-version.

### 5.8 The bare `alarm` and `protection` keys are bitfields, and are not scanned

`alarm` ranges 0–1024 and `protection` is 0 — these look like packed bitfields aggregating the
individual flags. The fault scanner's regex `/_(alarms?|protection)$/i` requires an underscore
before the suffix, so the bare keys do not match and are skipped. That is defensible — the 34
individual flags carry the same information in a more usable form — but it is worth knowing that
a non-zero bare `alarm` (observed once, at 1024) currently raises nothing.

---

## 6. Everything else in the packet

The 114 keys no dashboard query reads. `nbfc` marks fields read by the NBFC risk engine off the
same table (`src/lib/db/iot-queries.ts`) — they are not dashboard fields, but they are not dead
either, so do not treat them as free to drop.

| Group | Keys | Frame | Status |
|---|---|---|---|
| **Alarm / protection flags** (34) | `cell_over_voltage_*`, `cell_under_voltage_*`, `pack_over_voltage_*`, `pack_under_voltage_*`, `cell_over_temp_*`, `cell_under_temp_*`, `amb_over_temp_*`, `amb_under_temp_*`, `mos_over_temp_*`, `mos_under_temp_*`, `charge_over_current_*`, `discharge_over_current_*`, `buzzer_or_led_*`, `short_circuit_protection`, `thermal_runway_protection` | Fast | `nbfc` — `deriveOpenFaultsFromCan()` scans these for non-zero values in the last 24 h and maps them to DTC-style faults (protection ⇒ critical, alarm ⇒ warning). All 0 in the sample. |
| **Per-cell voltage** (24) | `cell_voltage_01..24` | Fast | Unused. Live and complete — the natural source for a cell-imbalance metric (`max − min` per frame). Slots beyond `no_of_cells` read 0 (§5.5). |
| **Per-cell temperature** (12) | `cell_temperature_01..12` | Medium | Unused. 65 % sentinel values (§5.5). |
| **Identity / config** (10) | `battery_serial_number_01/02`, `bms_serial_no_1/2`, `bms_firmware_version`, `protocol_version`, `chemistry`, `no_of_cells`, `no_of_temperature_sensors`, `iot_no` | Fast | Unused by the dashboard, which maps devices via CRM `device_battery_map` instead. `battery_serial_number_*` could cross-check that mapping against what the pack reports. |
| **Occurrence counters** (9) | `low_soc_occurence_count`, `over_voltage_occurance_count`, `under_voltage_occurance_count`, `charge_over_current_occurence_count`, `discharge_over_current_occurence-count`, `cell_over_deviation_occurence_count`, `fet_over_temp_occurence_count`, `short_circuit_protection_count`, `charge_cycle_count` | Slow | Unused. These are BMS-side lifetime counts of exactly the conditions the red-flag cards estimate from sampled data — a genuine cross-check on figures the dashboard currently labels as lower bounds (calculations §17). Note the inconsistent spelling: `occurence`, `occurance`, and one hyphen. |
| **Cumulative counters** (8) | `charge_cycle`, `discharge_cycle` (fast); `battery_charge`/`discharge_cummulative_capacity`, `battery_charge`/`discharge_run_hrs`, `cummulative_charge`/`discharge_energy` (slow) | Mixed | Unused. `charge_cycle` / `discharge_cycle` (1–274, fast) are BMS-counted cycles — an independent check on the SOC-rise cycle detection in calculations §2. The `cummulative_*_energy` pair is dead (§5.6). |
| **Pack min/max summary** (4) | `maximum_cell_voltage`, `minimum_cell_voltage`, `maximum_cell_temperature`, `minimum_cell_temperature` | Fast | Unused, and the most valuable unused group. `maximum_cell_temperature` is the live alternative to `battery_temp` (§5.3); the voltage pair gives cell imbalance without reading all 24 slots. |
| **Pack-level state** (13 unused of 18) | `soh` (`nbfc`), `soh_1`, `enum`, `alarm`, `protection`, `dod`, `mfh`, `allow_charging`, `allow_discharging`, `balancing_status`, `charger_mode`, `current_request_cc_mode`, `voltage_request_cv_mode` | Mixed | `soh` is read by the NBFC `getSohDelta30d()` — and is constant, so that delta is always 0 (§5.4). `enum` is the unused direction flag (§5.2). `allow_charging` / `allow_discharging` are live BMS permission flags that would distinguish "not charging" from "not allowed to charge". |

---

## 7. Trust summary

| Field | Live? | Use it for | Watch out for |
|---|---|---|---|
| `soc` | ✅ 100 % | cycle boundaries, Ah, deep discharge, cadence | ~100 distinct rows/day — cycle edges are coarse |
| `current` | ✅ 100 % | Ah integral, current envelope, over-current | unsigned — never infer direction from it |
| `battery_voltage` | ✅ 100 % | voltage envelope, under/over-voltage | thresholds are per-model, not fixed |
| `rated_capacity` | ✅ 100 % | nameplate, capacity bands, SOC-derived Ah | falls back to E-190 spec; check `rated_capacity_source` |
| `battery_temp` | ⚠ 2 % | temperature series, over-temperature | carried forward ~13 h; live alternative unread |

## 8. Open questions

Ranked by what they would change. None is actioned here — each needs verification against a full
extract first.

1. **Should the temperature series read `maximum_cell_temperature` instead of `battery_temp`?**
   Would move the Electrical tab's temperature figures from a ~13 h-stale value to a live one (§5.3).
2. **Is `soh_1` the real SOH signal?** Would potentially restore Avg SOH and Warranty At-Risk,
   both currently withheld across the whole fleet (§5.4).
3. **Do the BMS `*_occurence_count` fields agree with the red-flag counts?** The cards are
   documented as lower bounds; the BMS keeps true lifetime counts (§6).
4. **Do `charge_cycle` / `discharge_cycle` agree with detected cycles?** A free correctness check
   on the cycle detection in calculations §2.
5. **Should `enum` corroborate SOC-derived direction**, particularly across flat stretches where
   `dsoc = 0` (§5.2)?
6. **Is the "volatge" misspelling per-device or per-firmware?** Determines whether a consumer needs
   permanent dual-spelling handling (§5.7).

---

## Appendix — evidence and its limits

Every measurement here comes from `docs/telemetry_can.csv`:

```
100 rows · 70 distinct vehicles · 2026-06-25 00:02:40Z → 03:05:23Z (~3 hours)
57 of the 70 vehicles appear exactly once; the most frequent appears 9 times
119 distinct payload keys
```

**This is enough for** which keys exist, their shape and units, their observed ranges, and the
fast/medium/slow frame split — all structural properties visible in any frame.

**This is not enough for** rates, per-vehicle behaviour, seasonal effects, or anything about how
often a condition occurs. A three-hour window on one day cannot tell you a fault never fires; it
tells you no fault fired in those three hours. Findings in §5.3 and §5.4 are written as candidates
for exactly this reason.

Reproduction: parse the CSV with a quote-aware reader (`""` escapes inside the payload column),
`JSON.parse` the third column, then compare each key's inner `timestamp` against the row's `time`
to classify the frame. The live-share figures use a 60 s freshness cut.

Code read sites verified with:

```
grep -rn "payload\s*\(->\|?\)" src/
grep -rn "telemetry_can" src/
```

---

*Written 2026-07-25. Field list valid as of commit on branch `Aditya`. If a new `payload->` read
site is added, update §2 and the count in the opening paragraph.*
