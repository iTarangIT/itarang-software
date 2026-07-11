  # Intellicar Dashboard — Calculations

  Plain reference for every number shown on `/ceo/intellicar`.

  ---

  ## 1. Data source

  Battery telemetry comes from the `telemetry_can` table (live AWS poller). Each row has a
  JSONB `payload`:

  | Value | Where | Meaning |
  |-------|-------|---------|
  | SOC % | `payload->'soc'->>'value'` | State of charge, 0–100 |
  | Pack current (A) | `payload->'current'->>'value'` | Charge/discharge current, **unsigned magnitude** |
  | Rated capacity (Ah) | `payload->'rated_capacity'->>'value'` | Nameplate, e.g. 105 |

  Live snapshot per vehicle (SOC, SOH, GPS, online flag) comes from `vehicle_state`.

  Two properties of this feed drive everything below, and both are counter-intuitive:

  **Pack current cannot tell you the battery is charging.** It is reported unsigned, and
  discharge current (up to ~57 A) runs *higher* than charge current (~21 A). Current > 0
  is a necessary condition for charging, never a sufficient one. Rising SOC is the signal.

  **~96% of rows repeat a timestamp.** The poller re-inserts the latest CAN frame on every
  poll whether or not the device produced a new one. Every query here must dedupe with
  `DISTINCT ON (time)` first; without it, `time - LAG(time)` is 0 across each duplicate and
  those samples silently contribute no Ah at all.

  ---

  ## 2. Charging cycle detection

  Samples for one battery are **deduped by timestamp**, then ordered by time. For each:

  ```
  dSOC = SOC(now) − SOC(previous)
  dt   = seconds between this sample and the previous
  ```

  A sample belongs to a **charging session** when:

  ```
  dSOC ≥ 0   AND   dt ≤ 3600 seconds (SESSION_GAP_MAX_S)
  ```

  - SOC going up = charging.
  - A gap longer than an hour, or SOC dropping, **ends** the session and starts a new one.
  - The gap is sized to the *real* sample cadence of `telemetry_can` (median 8.5 min, p90
    ~33 min), not to the device's nominal 30 s stream. A tighter bound splits genuine
    sessions in half.

  The session is then **trimmed** to the actual charge:

  ```
  cycle starts at  the first sample carrying current (current > 0)
  cycle ends at    the last sample where SOC still rose (dSOC > 0)
  ```

  Ending on the last *rising* sample rather than the last current-carrying one keeps the CV
  taper (current falling to 0 as SOC reaches 100) inside the cycle, while leaving out the
  long idle stretch that follows at a flat 100%.

  Interior zero-current stretches — the charger pausing mid-charge — stay **inside** the
  cycle. They contribute no Ah, but they must not split it in two.

  A cycle is **valid** only if all of these hold:

  ```
  end SOC > start SOC                        SOC actually rose
  (end SOC − start SOC) ≥ 5                  a real charge, not a blip   (TELEMETRY_MIN_CYCLE_SOC_GAIN)
  Ah charged > 0                             charge actually flowed
  samples ≥ 5                                enough points to integrate  (TELEMETRY_MIN_CYCLE_SAMPLES)
  at least one sample carrying current       current readings present
  ```

  Corrupt CAN frames are dropped before any of this: a current reading whose magnitude
  exceeds 500 A (`TELEMETRY_MAX_VALID_CURRENT_A`) is a decode fault on a pack that peaks
  near 57 A, and integrating it would silently inflate the Ah total. A *missing* current
  reading is not corrupt, so it stays.

  The sample floor matters more than it looks: two samples describe a single interval — one
  straight line through an entire charge. That is not an integral, it is a guess with a
  slope. On the reference battery, 19 of 34 raw runs had fewer than 5 samples.

  ---

  ## 3. Ah charged per cycle (coulomb counting)

  Coulomb counting is an integral, `Ah = ∫|I| dt`, and it is only as good as the time axis.
  For every interval inside the cycle:

  ```
  Ah charged = Σ  (|I(previous)| + |I(now)|) / 2  ×  (dt / 3600)
  ```

  Three things to note, each of which was previously wrong:

  - **dt is the real elapsed time** between consecutive (deduped) samples — not a nominal
    packet interval, and not zero.
  - **Trapezoidal**, not rectangular. At an 8.5-minute median spacing, holding one
    endpoint's current across the whole interval mis-states a ramping or tapering charge.
  - **Every interval in the cycle counts**, not only those where SOC ticked up. SOC is
    quantised to whole percent; current keeps flowing between ticks.

  The cycle's *first* interval is excluded — it reaches back into the idle time before the
  charger was plugged in. The remaining intervals tile `[start, end]` exactly, which is what
  makes the total an integral over the charge and lets coverage (§4) be read against duration.

  ---

  ## 4. Data coverage

  Our stored telemetry is sparse: the poller keeps ~100 distinct samples per battery per day
  against a device that streams every ~30 s. Across a long gap we are interpolating current
  from the two endpoints, which is a guess, not a measurement.

  ```
  coverage % = (elapsed time inside intervals ≤ 1200 s) ÷ (cycle duration) × 100
  ```

  Long intervals still accrue Ah — the time really did elapse — but they do not count as
  covered. Coverage is what licenses the extrapolation in §5.

  ---

  ## 5. Estimated battery capacity (extrapolation to 100%)

  ```
  SOC difference = end SOC − start SOC

  Estimated capacity (Ah) = Ah charged ÷ (SOC difference / 100)
  ```

  **Calculated only when `SOC difference ≥ 20`** (`TELEMETRY_MIN_SOC_DIFFERENCE`).

  The division multiplies any error in the Ah total by `100 / SOC difference`. At a 5% swing
  that is ×20, and measured against real fleet data an ungated run produced a **191 Ah
  estimate on a 105 Ah pack**. At 20% the amplification is ×5 and every estimate lands in a
  credible band. Cycles below the gate are still detected and still counted — they simply
  carry no capacity, and do not appear on the AH Trend.

  **Why 20 and not 50.** The threshold was 50, and it was throwing away nearly everything: of
  34 detected cycles on the reference battery, only **2** cleared a 50% swing, and only **1**
  cleared 50% *and* the coverage floor. A one-point "trend" is not a trend. Sweeping the
  thresholds against six months of real data:

  | SOC gate | Cycles plotted | Capacity range | Implausible vs 105 Ah |
  |---|---|---|---|
  | 0% | 34 | 47–**191** Ah | 2 |
  | 10% | 24 | 47–126 Ah | 0 |
  | **20%** | **13** | **76–126 Ah** (mean 103.9) | **0** |
  | 50% | 2 | 99–99 Ah | 0 |

  20% is the point where the estimates stay physically credible without gutting the trend.

  **Coverage is a confidence signal, not a filter** (`TELEMETRY_MIN_COVERAGE_PCT`, default 0
  = off). A 70% coverage floor cut 13 usable cycles to 2 without removing a single implausible
  estimate — the SOC gate was already doing that work. So low-coverage cycles are plotted, with
  a **hollow marker** and their coverage in the tooltip, rather than silently dropped. Raise the
  floor if the poller is ever fixed and dense data makes strictness affordable.

  **Plausibility check.** The estimate is compared against the BMS nameplate
  (`rated_capacity`). Anything outside 0.3×–1.5× of rated is flagged: a pack cannot hold far
  more than it is rated for, and one at a third of nameplate would be scrap rather than in
  service. An estimate outside that band means the *measurement* is broken, not the battery.

  ---

  ## 5a. Why the vendor spreadsheet says 19.26 Ah, and why that is wrong

  `docs/intellicar/CAN Data.xlsx` works the same reference cycle (battery
  `TK-51105-02DZ-213416`, 24% → 100% on 2026-06-11) and concludes **19.26 Ah**. Do not
  "correct" our numbers to match it.

  The sheet multiplies each sample's current by a `time_difefrence` column — a *nominal*
  ~30 s packet interval, not the spacing between the rows in the dump, which are subsampled
  ~5×. It matches the real timestamp delta in 7 of 5,222 rows. Summed across the cycle it
  accounts for **3,060 s of a 16,380 s charge — 18.7% of the elapsed time**:

  | | Sheet | Corrected (§3) |
  |---|---|---|
  | Time integrated | 3,060 s (18.7%) | 16,380 s (100%) |
  | Ah charged | 14.64 | **71.41** |
  | SOC difference | 76% | 76% |
  | Estimated capacity | **19.26 Ah** | **94.0 Ah** |

  The battery's BMS reports a **105 Ah nameplate at SOH 100%**, so a 19.26 Ah pack is
  physically impossible; 94.0 Ah is what a real 105 Ah pack delivers once CV-taper at the top
  of the charge is accounted for. This is pinned by a regression test against the sheet's own
  rows: `src/lib/telemetry/__tests__/charging-math.test.ts`.

  ---

  ## 6. Charts

  | Chart | Plots |
  |-------|-------|
  | **AH Trend** | `Estimated capacity (Ah)` — one point per cycle that passes the §5 gates, against the nameplate |
  | **Charging Timeline** | SOC against time, with detected cycles shaded — the chart that makes detection falsifiable by eye |

  **AH Trend plots capacity, not Ah charged — despite its name.** Ah charged depends on the
  starting SOC (20% → 100% adds more Ah than 80% → 100% on an identical pack), so a trend of it
  tracks charging *habits*, not battery health. Estimated capacity normalises that out, so a
  decline in this chart means real degradation. The title is kept for continuity with what the
  team already calls it.

  Straight line segments and circular markers, no curve smoothing: each point is one measured
  cycle, and a smoothing curve would draw capacity values between them that were never measured.

  Cycles without a capacity estimate are **left out** of the line rather than plotted as gaps —
  a point we declined to compute is not a point on a degradation trend. Cycle numbers in the
  tooltip still count every detected cycle, so a jump from #3 to #7 is a visible, honest gap.

  A **hollow** marker means coverage below 40%: the point is on the trend, but its capacity
  leans on interpolation across telemetry gaps, so it should not be weighed like a
  densely-sampled cycle.

  Period filters: 1 / 3 / 6 months, a specific calendar month, or a custom date range.

  ### How much can this trend actually tell you

  Not as much as it looks. On the reference battery the plotted estimates span **75.6–126.4 Ah**
  around a mean of 103.9 (nameplate 105). That ±25% scatter is **sampling noise, not
  degradation** — it comes from the poller storing ~100 samples/day against a ~30 s device
  stream, so most cycles are integrated from 5–10 points.

  What the chart supports today: spotting a battery whose mean capacity sits well below its
  nameplate, or one whose estimates are wildly erratic. What it does **not** support: reading a
  1–2% year-on-year degradation off the line. Getting there requires fixing the poller (§1), not
  tuning these thresholds.

  ---

  ## 7. Summary cards (selected battery)

  ```
  Charging Cycles   = number of kept cycles
  Total Ah Charged  = Σ Ah charged (all cycles)
  Avg Ah / Session  = average of Ah charged
  Avg Capacity      = average of Estimated capacity   (only cycles that had one; else N/A)
  Avg Duration      = average cycle length in minutes
  Avg SOC Gained    = average of (end SOC − start SOC)
  ```

  ---

  ## 8. Charging Analysis export

  **Download Charging Analysis** on the Trip Analytics tab exports one Excel workbook for
  the selected battery and period, so the numbers above can be checked by hand.

  | Sheet | Contents |
  |-------|----------|
  | `Summary` | One row per charging cycle: start/end timestamp, start/end SOC, SOC difference, duration, avg/max current, Total Ah, data coverage, estimated capacity, nameplate |
  | `Cycle-01` … `Cycle-NN` | The raw telemetry of one cycle — timestamp, SOC, current, voltage, time difference, Ah increment, running Ah — plus that cycle's totals |
  | `Master Raw Data` | Every sample in the period, tagged with its charging cycle and charging status |

  Notes for anyone reconciling the sheets:

  - Every cycle number on `Summary` and in each cycle sheet's footer comes from the *same
    query that feeds the dashboard cards*. The per-sample rows are evidence, not the source
    — they are never re-summed to produce a total (Postgres and JS round differently).
  - Summing a cycle sheet's `AH Increment` column *does* reproduce its `Total AH`. The first
    row carries no increment: its interval reaches back into the idle time before charging
    began, so the cycle's Ah is integrated over `[Start Timestamp, End Timestamp]` exactly.
  - Rows with a flat SOC, and interior pauses where current drops to 0, are part of the cycle
    (§3). They are not skipped.
  - A row on `Master Raw Data` can read `Charging` with no cycle ID: its run was dropped by
    the ≥ 5% swing / Ah > 0 filter in §2.
  - A capacity shown in **red** contradicts the nameplate (§5) — a measurement fault, not a
    degraded pack.
  - All timestamps are IST (Asia/Kolkata).

  Exports are capped at 100,000 samples and 100 cycles; a wider period is rejected up front
  with the actual sample count and a message asking for a narrower date range. Use the month
  picker to narrow it. At the cap the workbook takes ~15 s to build and lands around 8 MB.

  ## 9. Battery status (Fleet Devices table)

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

  ## 10. Fleet KPIs (top cards)

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

  ## 11. Table colour thresholds

  ```
  SOC:  > 50 green   |  > 20 amber   |  else red
  SOH:  > 80 green   |  > 60 amber   |  else red
  ```
