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

  **Most rows repeat a timestamp** — 67% of them on the reference battery over six months
  (7,109 stored rows carry 2,331 distinct timestamps); it has been measured as high as 96% on
  other windows, so treat the ratio as variable and never assume it.
  The poller re-inserts the latest CAN frame on every
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
  dSOC ≥ 0   AND   dt ≤ 7200 seconds (TELEMETRY_SESSION_GAP_MAX_S)
  ```

  - SOC going up = charging.
  - A gap longer than two hours, or SOC dropping, **ends** the session and starts a new one.
  - The gap is sized to the *real* sample cadence of `telemetry_can`, not to the device's
    nominal 30 s stream. **This cadence keeps drifting, and the gap has to follow it.** It
    was 3600 s, chosen when the p90 gap between stored samples was ~33 min. The poller has
    since slowed to a **p90 of ~62 min — above the old bound** — so the gap rule alone was
    cutting real charges in two, and the fragments then died on the ≥ 5% gain gate below.

  Measured against §2a's limb scan on the reference battery (62 real charges, 6 months):

  | `SESSION_GAP_MAX_S` | cycles counted | verdict |
  |---|---|---|
  | 3600 | 40 | under-count by 22 (35% of real charges missed) |
  | 5400 | 63 | over-count by 1 |
  | **7200** | **62** | **exact match** |
  | 10800 | 62 | exact match |

  7200 rather than 10800: both land on the ground truth, and the smaller value has less room
  to stitch two charges together across an idle.

  The session is then **trimmed** to the actual charge:

  ```
  cycle starts at  the last sample BEFORE SOC first ticked up
  cycle ends at    the last sample where SOC still rose (dSOC > 0)
  ```

  The start anchor used to be *the first sample carrying current*, and that truncated real
  charges. Pack current is an unsigned magnitude and is often absent or zero over a charge's
  opening samples, so the cycle began part-way up the ramp: on the reference battery a
  50% → 100% charge was recorded as **59% → 100%**, losing 9 points of the swing that §5
  divides by. Anchoring on the sample that *preceded* the first genuine SOC tick keeps
  `start SOC` at the pre-charge SOC, and keeps the excluded first interval (§3) the one that
  reaches back into idle.

  Ending on the last *rising* sample rather than the last current-carrying one keeps the CV
  taper (current falling to 0 as SOC reaches 100) inside the cycle, while leaving out the
  long idle stretch that follows at a flat 100%.

  Interior zero-current stretches — the charger pausing mid-charge — stay **inside** the
  cycle. They contribute no Ah, but they must not split it in two.

  A cycle is **counted** — this drives the cycle count, Total Ah Charged and Avg Duration —
  only if all of these hold:

  ```
  end SOC > start SOC                        SOC actually rose
  Ah charged > 0                             charge actually flowed
  at least one sample carrying current       current readings present
  duration ≥ 300 s                           it lasted long enough to be a charge
                                             (TELEMETRY_MIN_CYCLE_DURATION_S)
  ```

  **A small charge is still a charge.** These four questions are all about physics. None of them
  asks how *big* the charge was, or how well we happened to sample it — and that is deliberate.

  Two rules used to sit here and no longer do:

  - `SOC gain ≥ 5` rejected every top-up. A driver charging 3% at a tea stall is a real event; the
    old rule deleted it from the count, from Total Ah, and from Avg Duration.
  - `samples ≥ 5` rejected every sparsely-polled charge (§2, and it cost 70% of the count).

  **Duration replaced the SOC-magnitude test.** A 1% tick over two minutes is a BMS re-estimate or
  quantisation noise; a 3% gain over twenty minutes, carrying current the whole way, is somebody
  plugging in. Duration asks whether something physically happened, which is the question detection
  is for.

  What replaces the deleted gates is not a looser threshold but **a different question**: detection
  says whether the charge happened, and the **confidence grade** (§5) says how far the numbers
  describing it can be trusted. **Rejecting a cycle and distrusting one are different facts, and the
  reader is owed the difference.**

  Corrupt CAN frames are dropped before any of this: a current reading whose magnitude
  exceeds 500 A (`TELEMETRY_MAX_VALID_CURRENT_A`) is a decode fault on a pack that peaks
  near 57 A, and integrating it would silently inflate the Ah total. A *missing* current
  reading is not corrupt, so it stays.

  **The sample floor is not in that list, and putting it there was the single largest error
  on this dashboard.** `samples ≥ 5` (`TELEMETRY_MIN_CYCLE_SAMPLES`) used to be a validity
  gate, so a real charge the poller happened to store only twice was deleted from the count,
  from Total Ah, and from Avg Duration. The poller stores ~100 samples per battery per day,
  so a 45-minute charge is routinely 2–4 rows: **61 of 89 detected runs held just 2 samples,
  and 22 real charges failed the ≥ 5 floor and nothing else.** The dashboard was reporting 16
  charges where 62 had happened — a 70% under-count.

  A sparsely-sampled charge is still a charge. It is only its *integral* that cannot be
  trusted. So the floor now gates **capacity only** (`enough_samples`, §5): the cycle is
  counted and contributes its Ah, it simply carries no capacity estimate — exactly as a cycle
  below the SOC-swing gate does.

  ---

  ## 2a. How we know the count is right

  Cycle detection is checked against a **limb scan**: a zigzag over the deduped SOC series
  that collapses it into monotone rising and falling limbs, tolerating a ±1% reversal as
  quantisation noise. Rising limbs with a gain ≥ 5% are the charges that physically happened.
  It shares no code with the detection rule, so the rule cannot mark its own homework.

  `scripts/diagnose-charging-cycles.ts` runs it (`npm run telemetry:diagnose-cycles`) and
  prints the ground-truth count beside what `cycleCTEs()` found, every cycle it dropped and
  *every* gate that cycle failed, the sessions that vanished without producing a cycle, and
  threshold sweeps. Run it after any change to this section. On the reference battery it now
  reads **62 ground-truth charges, 62 counted.**

  One known blind spot, shared by both: a charge → long flat idle → charge, with no discharge
  between, is indistinguishable from one long charge **by SOC alone**, and the limb scan
  cannot separate them either. Two of the 62 runs are such merges. Current could in principle
  separate them (an unplugged charger draws nothing), but a zero-current stretch is also what
  a mid-charge pause looks like, and those must stay inside the cycle.

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
  covered. Coverage is what licenses the extrapolation in §5, and since the session gap
  widened to 7200 s (§2) it is a **hard floor** there, not merely a confidence signal.

  ---

  ## 5. Estimated battery capacity (extrapolation to 100%)

  ```
  SOC difference = end SOC − start SOC

  Estimated capacity (Ah) = Ah charged ÷ (SOC difference / 100)
  ```

  **A capacity is calculated for EVERY cycle whose SOC rose.** Nothing is withheld. The only
  refusal is arithmetic: a non-positive ΔSOC has nothing to extrapolate.

  What varies is **how far the number can be trusted**, and that is stated explicitly:

  ```
  capacity_confidence = high | medium | low
  ```

  | Grade | Requires |
  |---|---|
  | **high** | ΔSOC ≥ 20 **and** coverage ≥ 15% **and** samples ≥ 5 |
  | **medium** | ΔSOC ≥ 10 **and** coverage ≥ 7.5% **and** samples ≥ 3 |
  | **low** | anything else |

  A cycle is only as good as its **worst** evidence, so `high` requires all three. Three things
  independently wreck the extrapolation:

  - **SOC swing.** The division multiplies any error in the Ah total by `100 / ΔSOC`. At 20% that
    is ×5 and the estimates land in a credible band. At 5% it is ×20. At 1% it is ×100, and the
    answer is noise wearing a decimal point.
  - **Coverage.** Below the floor, the current between samples is interpolated, not measured — a
    straight line drawn through a curve nobody saw.
  - **Sample count.** Two samples describe a single interval: one straight line through an entire
    charge. That is not an integral, it is a guess with a slope.

  **Why grade instead of gate.** Withholding a number tells the reader *nothing*. A number with its
  confidence attached tells them everything they need to decide what to do with it. The old rules
  deleted the estimate and left an unexplained hole in the chart; the reader could not tell a cycle
  we distrusted from one that never happened.

  **Carry the grade wherever you carry the number.** The consumers all do:

  | Consumer | Behaviour |
  |---|---|
  | Capacity Degradation chart | the **trend line joins `high` only**; `medium`/`low` are plotted hollow, off the line |
  | Capacity by Period | averages **`high` only** — averaging noise back in would defeat the chart's only purpose |
  | "Avg Capacity" card | **`high` only** |
  | Excel export | every cycle, with a **Confidence** column; `low` rows greyed |

  On the reference battery: **64 cycles — 12 high, 14 medium, 38 low.** The high-confidence mean is
  **106.0 Ah against a 105 Ah nameplate**, unchanged from when the gates were hard. Loosening
  detection did not corrupt the trustworthy numbers; it stopped hiding the untrustworthy ones.

  ### The evidence behind the grade thresholds

  Swept at the 20% SOC gate on the reference battery, back when coverage was a hard floor:

  | Coverage floor | Plotted | Capacity range | sd | Implausible vs 105 Ah |
  |---|---|---|---|---|
  | 0% | 44 | **40**–148 Ah | 17.4 | 0 |
  | 5% | 27 | 82–142 Ah | 12.1 | 0 |
  | 10% | 16 | 90–142 Ah | 12.3 | 0 |
  | **15%** | **12** | **90–122 Ah** (mean 106.0) | **9.7** | **0** |
  | 20% | 7 | 93–119 Ah | 8.8 | 0 |
  | 40% | 3 | 98–119 Ah | 9.9 | 0 |

  15% is the knee — it halves the scatter and removes the physically impossible estimates (a **40 Ah
  reading on a 105 Ah pack**), which is why it is the coverage threshold for `high`. 20% buys another
  0.9 of standard deviation for five of the twelve points, a bad trade.

  Note what the 0% row shows, because it is the whole argument for grading: **the plausibility check
  passes all 44 of those estimates.** The 0.3×–1.5× band is a check on *arithmetic*, not on
  *evidence* — a 40 Ah estimate sits inside it and is still worthless. Only the confidence grade
  catches that, and only because it looks at coverage and sample count, not just at the answer.

  **Plausibility check.** The estimate is compared against the BMS nameplate
  (`rated_capacity`). Anything outside 0.3×–1.5× of rated is flagged in red: a pack cannot hold far
  more than it is rated for, and one at a third of nameplate would be scrap rather than in
  service. An estimate outside that band means the *measurement* is broken on that cycle, not the
  battery. It is **not** a substitute for the confidence grade — see the 0% row above.

  ---

  ## 5a. The complete per-cycle record

  Every validated charging cycle carries all of this. None of it is ever withheld.

  | Field | Notes |
  |---|---|
  | Charging Cycle Number | 1-based, chronological |
  | Start / End Timestamp | IST in the export |
  | Charging Duration | |
  | Start SOC / End SOC | |
  | SOC Difference | end − start |
  | Total Charged Ah | trapezoidal integral of \|I\| over **real elapsed time** (§3) |
  | **Estimated Battery Capacity (Ah)** | **always present** — read it with the grade |
  | **Capacity Confidence** | high / medium / low (§5) |
  | Average Charging Current | over the samples carrying current |
  | Peak Charging Current | |
  | Total CAN Samples | |
  | **Average Sampling Interval** | `duration ÷ (samples − 1)` — n samples bound **n−1** intervals, and dividing by n understates the spacing by a whole interval |
  | Data Coverage | §4 |
  | Max gap | the widest silence inside the charge |

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

  Not as much as it looks. On the reference battery the plotted estimates span **90.2–122.3 Ah**
  around a mean of 106.0 (nameplate 105) — 12 points over six months. That residual ±15% scatter
  is **sampling noise, not degradation**: the poller stores ~100 samples/day against a ~30 s
  device stream, so even the cycles that clear the coverage floor are integrated from a handful
  of points.

  What the chart supports today: spotting a battery whose mean capacity sits well below its
  nameplate, or one whose estimates are wildly erratic. What it does **not** support: reading a
  1–2% year-on-year degradation off the line. Twelve points at ±15% cannot resolve a 2% trend,
  and no threshold in this document will change that — **getting there requires fixing the
  poller** (§1), which is Python on AWS, outside this repo.

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

  The pre-flight count is taken from the **deduped** `raw` CTE — the same set the export's rows
  come from. It used to be a hand-written query that claimed in its own comment to mirror `raw`
  and mirrored neither the `DISTINCT ON (time)` nor the current bound, so it counted duplicate
  timestamps and rejected periods far too early: on the reference battery it read 7,109 samples
  where the export would have written 2,333. It is now built *from* `cycleCTEs()` rather than
  beside it, so the two cannot drift apart again.

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

  ---

  ## 12. Discharge cycle detection

  A **discharge cycle** is the depletion between two charges. It legitimately spans several
  trips and the parks between them — it ends when the charger goes on, not when the vehicle
  stops.

  Detection mirrors §2, composing the same deduped `raw → samples → stepped` prefix
  (`sampleCTEs`), so the dedupe, the `dsoc`/`dt` window and the trapezoid term are defined
  once for both directions. Everything after that differs, because **charge and discharge are
  not symmetric**:

  | | Charge (§2) | Discharge |
  |---|---|---|
  | session | `dSOC ≥ 0` and `dt ≤ 7200 s` | `dSOC ≤ 0` and `dt ≤ 7200 s` |
  | trim start | last sample before the first *rise* | last sample before the first *fall* |
  | trim end | last *rising* sample | last *falling* sample |
  | **Ah accrual** | **every** interval in the cycle | **only** intervals where `dSOC < 0` |

  A cycle is **counted** when SOC actually fell, by at least 5 points
  (`TELEMETRY_MIN_DISCHARGE_SOC_DROP`). **There is no sampling-density gate on detection** —
  that mistake cost the charge side 70% of its real events (§2), and it is not repeated here.

  **Why Ah accrues only where SOC fell.** The charge chain accrues on every interval inside
  the cycle, flat-SOC ones included, so the intervals tile the cycle exactly and the total is
  a true integral. Copying that rule bills a parked vehicle at the road's current: `LAG`
  carries the last trip's ~40 A into a ten-hour flat stretch that sits *inside* the cycle.
  Measured on the reference battery that is worth **+2.9%** (3,554 Ah naive against 3,455 Ah
  correct) — real, but far short of the order-of-magnitude error the rule was first written to
  prevent. The reason it is not worse is the trim: `cyc_last` is the last *falling* sample, so
  the long overnight park at the bottom of a discharge already falls outside the cycle.

  The consequence to remember is structural rather than numerical: because the intervals no
  longer tile the cycle, **coverage is meaningless on the discharge side** and the coulomb
  total is a partial integral by construction.

  **Verified the same way as the charge side** (§2a): the limb scan's *falling* limbs are the
  ground truth. On the reference battery, **62 falling limbs, 61 cycles detected.**

  ---

  ## 13. Ah discharged — two methods, and which to trust

  ```
  SOC-derived (PRIMARY)  Ah = (startSOC − endSOC) / 100 × ratedCapacity
  Coulomb     (CHECK)    Ah = ∫|I| dt , over the falling intervals only
  ```

  **The SOC-derived figure is the primary series.** SOC is a *state*, not a rate, so it needs
  only the two endpoints and does not degrade as the poller gets sparser. The coulomb integral
  does: discharge current swings between 0 and ~57 A with traffic and stop-starts, so
  interpolating it across a 33-minute gap (our p90) is a straight line drawn through a curve
  nobody saw. On *charge* the interpolation is defensible because current is genuinely steady
  through the CC phase; on discharge it is not.

  The cost is that the SOC method inherits the BMS's own SOC estimate, drift and all. That is a
  known, bounded error. The coulomb integral's error under sparse sampling is neither.

  **The divergence between them is the honest confidence signal.** Two independent routes to the
  same quantity: where they agree, both are probably right; where they diverge, the telemetry was
  too sparse to integrate. On the reference battery the **median |divergence| is 20%**, so the
  coulomb series is worth showing alongside — as a dashed secondary line, never as the headline.
  A cycle with fewer than `TELEMETRY_MIN_DISCHARGE_SAMPLES` (5) samples carries **no** coulomb
  figure at all, exactly as a sparse charge carries no capacity (§5).

  **Sanity check that the whole model passes:** over six months the reference battery charged
  3,117 Ah and discharged 3,736 Ah — a ratio of 0.83. Two entirely independent measurements
  agreeing within 25% is the strongest evidence available that neither is badly wrong.

  ---

  ## 14. Deep discharge events (< 20% SOC)

  A **Schmitt trigger**, not a threshold:

  ```
  enter the event when SOC <  20   (TELEMETRY_DEEP_DISCHARGE_ENTER_PCT)
  leave  the event when SOC >= 25  (TELEMETRY_DEEP_DISCHARGE_EXIT_PCT)
  ```

  Between the two the state is *carried*. The 5-point hysteresis band is what makes one
  physical event one row: a bare `SOC < 20` filter counts a battery hovering at 19–21% as a
  new event on every wobble, and a battery parked at 12% for two days as dozens. On the
  reference battery, **163 samples below 20% debounce to 30 physical events** (May 9, June 14,
  July 7) — the naive count is 5× the truth.

  A series that opens *inside* the band has no prior state to carry, and is left with none:
  guessing one would fabricate an event out of an unknown.

  Each event reports the widest telemetry gap inside it. The low SOC is a fact whatever the
  sampling; the event's **duration** is only a fact if we were watching across it, so an event
  whose interior gap exceeds a session gap is flagged `duration_confident: false` rather than
  quoting a span we did not observe.

  ---

  ## 15. Distance, and the discharge-vs-distance scatter

  **There is no odometer column anywhere in the telemetry.** Distance has exactly one usable
  source:

  | Table | State |
  |---|---|
  | `distance_rollup` (`bucket_size='day'`) | **the only populated source.** 43 daily rows / 4,629 km on the reference battery |
  | `trips` | **EMPTY — 0 rows, fleet-wide.** The per-trip aggregator has never run |
  | `daily_distance_per_vehicle` | **EMPTY.** Its aggregator never ran either |
  | `distance_rollup.energy_kwh` | **100% NULL.** No energy overlay is possible |

  The empty `trips` table is why the **Trip History** panel shows "No trips found" while this
  same battery demonstrably drove 4,629 km. That is a data-pipeline gap in `iot_stack`, not a
  bug in the query.

  **A missing distance row is unknown, not zero.** `distance_rollup` is written by an aggregator
  outside this repo whose sibling table was never populated at all, so absence is not evidence
  the vehicle stood still. Coalescing a missing row to 0 asserts "parked" on a day we have no
  distance for, and a cumulative line that flattens for a fortnight then reads as *"this driver
  stopped working"* when it means *"the aggregator stopped writing"*. **`km = null` renders as a
  gap in the line, never as a zero**, and any total is a lower bound whenever gaps exist.

  Note also that the GPS/distance feed **predates the CAN feed** by a fortnight on this fleet:
  there are days with real kilometres and no battery telemetry at all. Battery telemetry is
  therefore reported alongside the distance, but it does **not** decide whether a distance point
  is drawn.

  ### Discharge vs kilometres

  Plotted **per day**, and that is a data constraint rather than a design choice: distance
  exists only as a daily rollup, so splitting a day's kilometres between the several discharge
  cycles inside that day would be an invention.

  The headline efficiency is the **aggregate** ratio (total Ah ÷ total km), not the mean of the
  per-day ratios. Per-day ratios are biased low wherever cycle detection resolved only part of a
  day's discharge — 27 May on the reference battery shows 118 km against a single detected
  cycle, giving 0.38 Ah/km where the pack really does about 1.2 — and averaging them lets an
  under-detected day count as much as a fully-resolved one. Summing first weights every kilometre
  equally. Reference battery: **1.158 Ah/km** across 29 days.

  Days with kilometres but no resolvable discharge cycle are **left out** of the scatter rather
  than dragged onto the axis at zero Ah. On the reference battery that is 14 of 43 driving days,
  so the scatter is a sample of the period, not a census of it.

  ---

  ## 16. Voltage and current — why they are bucketed, never plotted raw

  Pack voltage and current are shown as a **min–max envelope with a median line**, one band per
  day / week / month. They are never drawn as a per-sample line, and this is not a style
  preference.

  Voltage and current move on a **~1-second** timescale. We sample every **~8.5 minutes**
  (p90: 33 min). A line through those points is an *aliased* signal: it looks like a waveform,
  it invites the reader to see spikes and dips, and every one of those features is an artefact
  of when the poller happened to look — not an event. The envelope states exactly what is known
  (the range the value occupied in each bucket, and where its middle sat) and claims nothing
  more.

  Reference battery, six months: voltage 44.4–58 V (median 52.7), current 0–56.9 A (median ≈ 2 A,
  because the pack is idle most of the time), temperature median ≈ 42 °C / max 52.1 °C. Current
  is reported as an **unsigned magnitude**, so the current chart shows the *size* of the current,
  never its direction — charge and discharge both read positive (§1).

  ---

  ## 17. Red flags — and why most of them are lower bounds

  | Flag | Trustworthy? |
  |---|---|
  | Over Voltage / Under Voltage / Over Current | **NO — a floor, not a count** |
  | Over Temperature | **Yes** |
  | Weak Charge | **Yes** |

  **A breach count on a transient is a lower bound.** A real over-voltage or over-current event
  lasts *seconds*. We sample every ~510 s. The probability of catching a 5-second spike is about
  **1%** — so we miss roughly 99 of every 100. **"0 over-voltage" means we did not see one, not
  that there was not one**, and the UI says exactly that on the card face. Presenting it as a
  count would be the most dangerous number on this dashboard: an operator would read "zero
  faults" off a chart that structurally cannot see faults.

  The honest fix is upstream. The BMS sees every frame; the poller should emit an `alerts` row on
  a breach. No amount of query work in the CRM can reconstruct a transient from 1% of the data.
  **This is an `iot_stack` requirement, and it should be raised as one.**

  Two exceptions, and they are the reason the panel is worth shipping at all:

  - **Over Temperature works.** Thermal mass moves on a *minutes* timescale, so a thermal event
    is genuinely observable at this cadence. It is the only instantaneous red flag here that is
    a real count.
  - **"Under Current" is redefined as Weak Charge.** A naive threshold on instantaneous current
    fires on every parked vehicle and would count parked hours as faults — a useless number. The
    useful one is the **average current inside a detected charging cycle**: below the threshold
    means a failing charger or a high-resistance connection. Scoping it to a cycle is what turns
    a meaningless reading into an actionable one.

  ### Where the thresholds live

  `app_settings` (key `intellicar_battery_thresholds`) > env var > hardcoded default. No
  migration — the table already exists.

  **These thresholds colour this dashboard. They do NOT change what the alert poller fires on** —
  that lives in the Python poller in `iot_stack`, outside this repo, and the Intellicar
  alert-config endpoints are dead (`fetchAlertConfig()` returns `[]`, `updateAlertConfig()`
  throws). The settings UI must say so, or it is a control that looks like it arms an alarm and
  doesn't.

  The voltage/current/temperature defaults (44 V, 60 V, 70 A, 55 °C) are sized to what this
  fleet's telemetry actually shows — **they are not from a cell spec sheet.** Replace them with
  the manufacturer's limits before anyone acts on a breach count.

  ---

  ## 18. Capacity bands are fractions of the pack's own nameplate

  ```
  warning  = 0.90 × rated_capacity      (TELEMETRY_CAPACITY_WARNING_FRAC)
  critical = 0.80 × rated_capacity      (TELEMETRY_CAPACITY_CRITICAL_FRAC)
  ```

  On the 105 Ah packs in this fleet that is **94.5 Ah** and **84 Ah** — which is the 95/85 that
  was asked for — but expressed as a fraction it generalises to a pack of any rating instead of
  hard-coding one fleet's numbers into the chart.

  **A battery that reports no `rated_capacity` gets no bands at all.** It is not judged against a
  number invented for it.

  The bands are drawn as low-opacity zone washes with **labelled dashed rules** on top. The rules
  carry the meaning; the colour never does. That is what keeps the thresholds legible in
  greyscale, under colour-vision deficiency, and in a screenshot.

  ---

  ## 19. Chart trust levels

  Read this before quoting any number off the Battery Analytics tab.

  | Chart | Trust | Why |
  |---|---|---|
  | **Kilometre Trend / Cumulative Distance** | **High** | Measured distance; gaps shown as gaps (§15) |
  | **Deep Discharge Events** | **High** | SOC is a state; the Schmitt trigger is exact (§14) |
  | **Cumulative Charge / Discharge** | **High** | Two independent methods agree within 25% (§13) |
  | **Discharge vs Kilometres** | **Medium** | Daily attribution only; 14 of 43 driving days unresolved (§15) |
  | **Capacity by Period** | **Medium** | Averaging beats the noise down, but cannot resolve 1–2%/yr (§5) |
  | **AH Trend (per cycle)** | **Medium** | ±15% scatter is sampling noise, not degradation (§6) |
  | **Voltage / Current envelopes** | **Low-ish** | Honest about its range, but blind between samples (§16) |
  | **Over/Under Voltage, Over Current** | **Lower bound ONLY** | We see ~1% of transients (§17) |
  | **Over Temperature, Weak Charge** | **High** | Slow signals, genuinely observable (§17) |

  Everything on this page is limited by the same root cause: the poller stores ~100 samples per
  battery per day against a device that streams every ~30 s. **Fixing the poller is worth more
  than any further work in this repo.**

  ---

  ## 20. Location — heat map, dwell, parking, and the overnight spot

  Source: `telemetry_gps` (`time, vehicleno, lat, lon, speed_kph, heading, ignition, gps_fix`).
  **There is no PostGIS on this database**, so the great-circle distance is written out longhand
  in `geo-sql.ts` and mirrored by `haversineM()` in `geo-math.ts`.

  `telemetry_gps` has the same duplicate-timestamp defect as `telemetry_can`: **44% of rows repeat
  a timestamp** on the reference battery (8,765 rows, 4,929 distinct times). Every query dedupes
  with `DISTINCT ON (time)` first — without it `time - LAG(time)` is 0 across each duplicate and
  the dwell totals are silently wrong.

  ### Dwell is found by position, NOT by speed

  The obvious test for a parked vehicle is `speed_kph = 0`. **On this fleet that finds nothing:
  only 61 of 8,765 fixes report zero speed (0.7%)**, so an e-rickshaw that plainly parks overnight
  looks like it is moving 99.3% of the time. The tracker simply never emits a clean zero.

  Position does not lie:

  ```
  dwell  when displacement < 100 m   (TELEMETRY_DWELL_RADIUS_M)
  travel when displacement >= 30 m   (TELEMETRY_MOVE_MIN_M)
  ```

  The two thresholds deliberately overlap. The **move floor** exists because without it a
  stationary vehicle earns kilometres from its own GPS noise — a 10 m wobble every 4 minutes is
  ~3.6 km/day of phantom travel, and it would light the heat map brightest exactly where the
  vehicle never moved.

  This also handles a sleeping tracker: if the fix before a gap and the fix after it are in the
  same place, the vehicle did not go anywhere, and **the silence itself is the dwell**.

  ### The kilometre heat map is weighted by DISTANCE, not by fix count

  A point-density heat map lights up brightest wherever the vehicle sat longest — which is
  precisely where it travelled *least*. A reader takes that bright blob for "the busy route" when
  it means "the car park". Weighting each ~111 m grid cell by the kilometres driven through it
  makes the roads glow and the car park go dark, which is what a *kilometre* heat map is for.

  "Time spent" is the opposite question and gets its own layer, weighted by hours.

  ### GPS distance is a LOWER BOUND — never quote it

  Summing straight-line hops between fixes gives **3,398 km** on the reference battery against the
  **4,629 km** `distance_rollup` reports — **27% short, and short by construction**: fixes arrive
  about every 4 minutes and a chord between two of them cuts every corner of the road between.

  It is kept only because it is exactly the right thing to *weight the heat map by* — the map needs
  relative intensity, and a systematic under-read applies equally everywhere. **§15 and the Usage
  tab own the distance total.** The payload field is named `gpsChordKm` to make that hard to misuse.

  ### Parking, and the overnight location

  ```
  parking = the dwell cluster with the most total hours
  home    = the dwell cluster with the most hours between 22:00 and 05:00 IST, across ≥ 1 night
  ```

  These are **different questions and often different places** — the busiest daytime dwell is
  usually a stand or a charging point, not a home.

  A "visit" is an *arrival*: a dwell interval whose previous interval was **not** a dwell. Counting
  fixes instead reports one overnight park as fifty visits. (This was a real bug: computing the
  `LAG` inside the already-dwell-filtered set meant every previous row was also a dwell row, so an
  arrival could never be detected and a 505-hour car park reported "1 visit".)

  **The overnight location is an inference, not an address.** It is where the vehicle sits at night
  across many nights — in practice usually where the driver lives, but the data says *"it parks here
  at night"* and nothing more. It is **not reverse-geocoded**, and the UI shows the runner-up
  clusters beside it, because the ranking is often close: the reference battery has two locations
  with heavy overnight presence (143 h / 29 nights, and 122 h / 23 nights). Presenting a ranked
  guess as a fact would be the whole error.

  **Dwell hours across a long gap are inferred, not observed.** If the tracker goes quiet for ten
  days and returns to the same spot, the vehicle very probably stayed — but nobody watched. Hours
  beyond `TELEMETRY_DWELL_TRUST_GAP_S` (6 h) are reported separately, and the UI states what share
  of the total is inferred (**27.9%** on the reference battery).

  ### Reference battery (6 months, Prayagraj)

  | | |
  |---|---|
  | GPS fixes (deduped) | 4,931 across 46 days |
  | Heat cells | 755 |
  | Moving / dwell | 625 h / 863 h |
  | Parking | 25.45700, 81.82900 — 505 h, 61 visits |
  | Overnight | same location — 143 h across 29 nights |
  | Second base | 25.30300, 81.89200 — 302 h, 40 visits, 122 night-hours |
