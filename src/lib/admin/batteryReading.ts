/**
 * How to read a "batteries to dealers" figure. CLIENT-SAFE (no db import).
 *
 * Batteries are counted from invoice item lines (HSN 8507). An invoice whose
 * lines were never captured contributes 0 whatever it sold, so a bare number
 * can lie: on 6 Oct 2026 prod showed "0 batteries" beside ₹82 lakh of battery
 * invoices because no invoice had lines. battery_lines (see SalesOutcome)
 * says how much of the figure is known:
 *
 *   unknown   invoices in range, none with lines — show "—", never 0
 *   partial   some without lines — the number is a floor
 *   complete  every invoice has lines, or there were no invoices (a real 0),
 *             or the pre-E-322 allocation fallback (no coverage notion)
 */
import type { SalesOutcome } from "./salesDashboardTypes";

export type BatteryReading = {
    state: "unknown" | "partial" | "complete";
    /** null when unknown. */
    value: number | null;
    invoices: number | null;
    with_lines: number | null;
};

export function batteryReading(o: Pick<SalesOutcome, "batteries_to_dealers" | "battery_lines">): BatteryReading {
    const cov = o.battery_lines;
    if (!cov) return { state: "complete", value: o.batteries_to_dealers, invoices: null, with_lines: null };
    const base = { invoices: cov.invoices, with_lines: cov.with_lines };
    if (cov.invoices > 0 && cov.with_lines === 0) return { state: "unknown", value: null, ...base };
    if (cov.with_lines < cov.invoices) return { state: "partial", value: o.batteries_to_dealers, ...base };
    return { state: "complete", value: o.batteries_to_dealers, ...base };
}
