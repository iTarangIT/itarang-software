import type { MonitorOverview } from "@/lib/telemetry/monitor-queries";

/**
 * What this page deliberately does not show, and why.
 *
 * Every line is DERIVED from the same request that drew the tiles, not written
 * here as a standing claim — so the day the aggregator is deployed or dealer_id
 * is backfilled, the corresponding line disappears on its own and nobody has to
 * remember to delete it.
 *
 * It earns its space because the alternative is worse. A dashboard that silently
 * omits battery health invites the same question every week; one that prints a
 * fleet SOH of 100% answers it with a number that is a stuck sensor rather than
 * a measurement, which is how a fleet ends up believing it has no warranty
 * exposure.
 */
export function NotMeasurableStrip({ facts }: { facts: MonitorOverview["notMeasurable"] }) {
    const items: Array<{ label: string; detail: string }> = [];

    if (facts.soh.reporting > 0 && facts.soh.distinctValues <= 1) {
        items.push({
            label: "Battery health (SOH)",
            detail: `all ${facts.soh.reporting} reporting packs return exactly ${facts.soh.constantValue}% — a stuck sensor, not a measurement`,
        });
    }

    if (facts.trips.tableMissing) {
        items.push({ label: "Trips", detail: "no trips table on this database" });
    } else if (!facts.trips.hasRows) {
        items.push({
            label: "Trips",
            detail: "table is empty — the trip segmentation job is not deployed",
        });
    }

    if (facts.energy.rowsInWindow > 0 && facts.energy.rowsWithValue === 0) {
        items.push({
            label: "Energy (kWh)",
            detail: `not recorded on any of the ${facts.energy.rowsInWindow.toLocaleString()} distance rows in the last 30 days`,
        });
    }

    if (facts.dealerAttribution.total > 0 && facts.dealerAttribution.mapped === 0) {
        items.push({
            label: "Dealer attribution",
            detail: `none of the ${facts.dealerAttribution.total} mapped vehicles carries a dealer, so the fleet cannot be split by dealer`,
        });
    } else if (
        facts.dealerAttribution.total > 0 &&
        facts.dealerAttribution.mapped < facts.dealerAttribution.total
    ) {
        items.push({
            label: "Dealer attribution",
            detail: `only ${facts.dealerAttribution.mapped} of ${facts.dealerAttribution.total} mapped vehicles carries a dealer`,
        });
    }

    if (items.length === 0) return null;

    return (
        <div className="rounded-xl border border-gray-200 bg-gray-50/80 px-6 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                Not shown, because it is not measurable
            </p>
            <ul className="mt-2.5 grid gap-x-8 gap-y-1.5 sm:grid-cols-2">
                {items.map((it) => (
                    <li key={it.label} className="text-xs text-gray-500 flex gap-2">
                        <span className="text-gray-300 select-none" aria-hidden>
                            &mdash;
                        </span>
                        <span>
                            <span className="font-medium text-gray-600">{it.label}</span>:{" "}
                            {it.detail}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
