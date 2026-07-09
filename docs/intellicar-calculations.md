# Intellicar Dashboard — Calculations

Plain reference for every number shown on `/ceo/intellicar`.

---

## 1. Data source

Battery telemetry comes from the `telemetry_can` table (live AWS poller). Each row has a
JSONB `payload`:

| Value | Where | Meaning |
|-------|-------|---------|
| SOC % | `payload->'soc'->>'value'` | State of charge, 0–100 |
| Pack current (A) | `payload->'current'->>'value'` | Charge/discharge current (sign varies) |
| Rated capacity (Ah) | `payload->'rated_capacity'->>'value'` | Nameplate, e.g. 105 |

Live snapshot per vehicle (SOC, SOH, GPS, online flag) comes from `vehicle_state`.

---

## 2. Charging cycle detection

Samples for one battery are ordered by time. For each sample:

```
dSOC = SOC(now) − SOC(previous)
dt   = seconds between this sample and the previous
```

A sample belongs to a **charging session** when:

```
dSOC ≥ 0   AND   dt ≤ 1200 seconds (20 minutes)
```

- SOC going up = charging.
- A gap longer than 20 minutes, or SOC dropping, **ends** the session and starts a new one.

Consecutive in-session samples are grouped into one **charging cycle**.

A cycle is kept only if:

```
(max SOC − min SOC) ≥ 5        (at least a 5% swing)
AND  Ah charged > 0
```

---

## 3. Ah charged per cycle (coulomb counting)

For every step inside a cycle where SOC rose and current was recorded:

```
Ah charged = Σ  |pack current|  ×  (dt / 3600)
```

(current in amps × time in hours = amp-hours, summed over the cycle)

---

## 4. Estimated battery capacity (extrapolation to 100%)

For each cycle we also track the SOC actually gained over the steps that had a current
reading:

```
SOC measured = Σ dSOC   (only steps where dSOC > 0 and current present)
```

Full 100% capacity is then extrapolated:

```
Estimated capacity (Ah) = Ah charged ÷ (SOC measured / 100)
```

**Rule:** this is calculated **only when `SOC measured ≥ 50`**.

- Reason: a 50% swing means the value is stretched at most ×2 → reliable.
- A small top-up (e.g. 5%) would be stretched ×20 → too noisy, so capacity = *empty* for
  that cycle (but the cycle still shows on the Ah Trend).

---

## 5. Charts

| Chart | Plots per charging cycle |
|-------|--------------------------|
| **Ah Trend** | `Ah charged` — every valid cycle |
| **Battery Capacity Trend** | `Estimated capacity (Ah)` — only cycles with SOC measured ≥ 50 |

---

## 6. Summary cards (selected battery)

```
Charging Cycles   = number of kept cycles
Total Ah Charged  = Σ Ah charged (all cycles)
Avg Ah / Session  = average of Ah charged
Avg Capacity      = average of Estimated capacity   (only cycles that had one; else N/A)
Avg Duration      = average cycle length in minutes
Avg SOC Gained    = average of (end SOC − start SOC)
```

---

## 7. Battery status (Fleet Devices table)

Checked in order — the first match wins:

```
1. open_alert_count > 0                                → Critical
2. NOT online (device/GPS not reporting)               → Offline
3. battery data stale or missing:                      → Battery Offline (disconnected)
     last_battery_at is NULL
     OR last_battery_at older than 24 hours
     OR SOC is NULL
     OR SOH is NULL
4. everything above passed                             → Healthy
```

Meaning: a battery is **Healthy** only if the device is online, has no open alerts, and its
battery reported fresh SOC + SOH within the last 24 hours. A tracker that reports GPS but
whose battery/BMS is silent shows **Battery Offline**, not Healthy.

---

## 8. Fleet KPIs (top cards)

```
Fleet Size       = total vehicles
Active Now       = vehicles where online = true
Utilization %    = round(Active Now / Fleet Size × 100)
Avg SOH %        = average of SOH across the fleet
Warranty At-Risk = count of vehicles where SOH < 80
Active Alerts    = count of alerts where resolved_at is NULL

Fleet Uptime     = Utilization %
Avg Daily Distance = average km/day over the last 7 days
Offline Devices  = Fleet Size − Active Now
```

---

## 9. Table colour thresholds

```
SOC:  > 50 green   |  > 20 amber   |  else red
SOH:  > 80 green   |  > 60 amber   |  else red
```
