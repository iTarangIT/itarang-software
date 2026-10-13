/**
 * Tracker ID 88 — how the Sales dashboard words the measures from
 * salesHeadMeasures.ts. CLIENT-SAFE and pure (no db import), so the screen and
 * the unit tests read one rule.
 */
import type { BatteryReading } from "@/lib/admin/batteryReading";

/** "Stuck": open leads in the same stage for more than this many calendar days. */
export const STUCK_DAYS = 7;

/** part / whole as a whole percent; null when there is nothing to divide by. */
export function share(part: number, whole: number): number | null {
    return whole > 0 ? Math.round((part / whole) * 100) : null;
}

/** "12 · 40%" — a count with its share, or the bare count when there is no share. */
export function countWithShare(n: number, pct: number | null, fmt: (v: number) => string = String): string {
    return pct == null ? fmt(n) : `${fmt(n)} · ${pct}%`;
}

/** Working hours as "3.5 h"; "—" when not measured. */
export function hoursText(h: number | null | undefined): string {
    return h == null ? "—" : `${h.toFixed(1)} h`;
}

export type BatteryEstimate = { units: number; leads: number } | null | undefined;

/**
 * ID 88 #4 — the scorecard's "Batteries sold" text when invoice item lines
 * are missing. Invoice lines stay the count; the estimate (battery units on
 * the dealer-approved quote of each lead behind a line-less invoice) is shown
 * beside it with "≈", never added into it silently.
 *
 *   unknown + estimate   "≈ 6"   note: from approved quotes, lines missing
 *   unknown, none        "—"     note: not tracked, N invoices have no lines
 *   partial + estimate   "4 + ≈2"
 *   partial, none        "4+"
 *   complete             the invoice count as is
 */
export function batteryText(
    r: Pick<BatteryReading, "state" | "invoices">,
    invoiceCount: string,
    est: BatteryEstimate,
    fmt: (v: number) => string = String,
): { actual: string; note?: string; estimated: boolean } {
    const has = Boolean(est && est.units > 0);
    if (r.state === "unknown") {
        return has
            ? {
                  actual: `≈ ${fmt(est!.units)}`,
                  note: `estimate from ${fmt(est!.leads)} approved ${est!.leads === 1 ? "quote" : "quotes"}: ${fmt(r.invoices ?? 0)} invoices have no item lines`,
                  estimated: true,
              }
            : { actual: "—", note: `not tracked: ${fmt(r.invoices ?? 0)} invoices have no item lines`, estimated: false };
    }
    if (r.state === "partial") {
        return has ? { actual: `${invoiceCount} + ≈ ${fmt(est!.units)}`, estimated: true } : { actual: `${invoiceCount}+`, estimated: false };
    }
    return { actual: invoiceCount, estimated: false };
}
