/**
 * A rounded axis band that frames the data instead of the origin.
 *
 * A zero-baseline is mandatory for bars, where the bar's *length* encodes the value.
 * It is wrong here: this is a line chart of capacities that all sit near 100 Ah, so
 * anchoring at 0 squashes every meaningful movement into the top fifth of the canvas
 * and the degradation the chart exists to show becomes invisible. The band is padded
 * around the data and the nameplate, and snapped to round ticks so the reader is never
 * decoding a number like 126.4 off an axis.
 *
 * Pure, and unit-tested in ../__tests__/capacity-axis.test.ts — which is why it lives in
 * its own module rather than inside a 'use client' component.
 */
export function capacityAxis(values: number[], rated: number | null) {
    const all = rated != null ? [...values, rated] : values;
    if (all.length === 0) return { domain: [0, 100] as [number, number], ticks: [0, 25, 50, 75, 100] };

    const min = Math.min(...all);
    const max = Math.max(...all);

    // Breathing room, not a margin. At 25% the padding was wide enough to push the band across a
    // coarser tick step, and snapping THAT down landed the floor on zero — a 54-151 Ah spread was
    // being drawn on a 0-200 axis, wasting the bottom third of the canvas on capacities no battery
    // in this fleet will ever report.
    const pad = Math.max((max - min) * 0.05, 5);

    // Up to 6 gaps, not 5. One extra gap lets a finer step win, which keeps the floor close to the
    // data instead of tumbling to the next round number far below it.
    const step = [5, 10, 20, 25, 50, 100].find((s) => (max + pad - (min - pad)) / s <= 6) ?? 100;

    const lo = Math.max(0, Math.floor((min - pad) / step) * step);
    const hi = Math.ceil((max + pad) / step) * step;

    const ticks: number[] = [];
    for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(Math.round(v));
    return { domain: [lo, hi] as [number, number], ticks };
}
