# Escalation: getting true 30-second telemetry (AWS poller)

**Status:** open — the fix is in the AWS `iot_stack` Python poller, **outside this repo**.
**Owner:** IoT/data-platform team (poller author).
**Written:** 2026-07-15, from the Battery Analytics "reads every 30 s" request.

## The ask

The CEO wants the dashboard (and the exported Excel) to reflect telemetry "every 30 seconds" —
the rate at which the device actually streams CAN frames.

## Why the dashboard cannot deliver this today

The device streams at ~30 s, but that is **not** what is stored. The dashboard reads the only
per-sample table it can reach — `telemetry_can` — and there the cadence is:

- **~8.5 min median** between distinct timestamps (p90 ~33 min, drifted to ~62 min),
- **~100 distinct samples per battery per day** (against a ~30 s device stream ⇒ ~2,880/day expected),
- **67–96 % of rows are duplicate timestamps** — the poller re-inserts the latest frame on every
  poll whether or not the device produced a new one.

See `docs/intellicar-calculations.md` §1–§4, §16, §19 for the measurements. No higher-frequency
or pre-dedup table exists in the reachable DB, so **true 30 s timestamps do not exist in the data
the CRM can query.** The dashboard now surfaces this honestly (the cadence readout under the
Battery Analytics stat cards; a cadence note in the exported workbook), and deliberately does
**not** fabricate a 30 s grid — interpolating one produces physically wrong numbers (the vendor
sheet's `time_difefrence` = nominal 30 s under-integrates a 71.41 Ah charge to 14.64 Ah /
19.26 Ah "capacity"; `docs/intellicar-calculations.md` §5a).

## What the poller must change (the only real fix)

In the AWS `iot_stack` Python poller:

1. **Stop re-inserting the latest CAN frame on every poll.** This is the source of the 67–96 %
   duplicate timestamps. Only write a row when the device timestamp is new.
2. **Persist each distinct device frame at its own timestamp** (~30 s apart), rather than
   subsampling to ~100 rows/day. If write volume is the concern, dedup by *frame content /
   device timestamp*, not by dropping frames.
3. **Verify cadence after the change** with the existing read-only tools:
   `npm run telemetry:diagnose-cycles` (§1 prints median/p90/max gap + duplicate %) and
   `scripts/polar-aggregator-review.mjs` (V2 ordering/cadence percentiles).

## Impact once fixed (no CRM change needed)

Every downstream number improves automatically, because the CRM already integrates over the
*real* elapsed `dt_s`:

- Ah/capacity integration stops aliasing (trapezoid over ~30 s instead of ~8.5 min gaps).
- The voltage/current envelopes approach the true waveform instead of a coarse range.
- Red-flag breach counts stop being ~1 % lower bounds (a 5 s spike is currently caught ~1 % of
  the time; `docs/intellicar-calculations.md` §17).
- The exported per-sample sheets show true ~30 s `Time Difference (s)` gaps.

Until then, the dashboard's cadence readout and the workbook note state the real ~8.5 min cadence
so no one mistakes a 30 s refresh for a 30 s feed.
