import { relativeAge } from "@/lib/telemetry/monitor-math";
import type { AttentionRowEnriched } from "@/lib/telemetry/monitor-queries";

/**
 * The vehicles that were reporting and have gone quiet, longest first.
 *
 * Vehicles that have NEVER reported are deliberately absent: they have their own
 * tile, there are a couple of dozen of them, and letting them sit at the top of
 * this list forever would bury the handful that changed state today — which is
 * the only thing on this page anyone can act on.
 */
export function AttentionTable({
    rows,
    neverReported,
    degraded,
}: {
    rows: AttentionRowEnriched[];
    neverReported: number;
    degraded?: boolean;
}) {
    return (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-6 pt-5 pb-3">
                <div>
                    <h3 className="text-base font-semibold text-gray-900">Needs attention</h3>
                    <p className="text-xs text-gray-500 mt-1">
                        Vehicles quiet for over an hour, longest silence first.
                    </p>
                </div>
                {neverReported > 0 && !degraded && (
                    <p className="text-xs text-gray-400">
                        {neverReported} never-reported {neverReported === 1 ? "device" : "devices"}{" "}
                        excluded
                    </p>
                )}
            </div>

            {degraded || rows.length === 0 ? (
                <div className="px-6 pb-6 pt-2">
                    <p className="text-sm text-gray-400">
                        {degraded
                            ? "Telemetry database unreachable — nothing measured."
                            : "Every vehicle has reported within the last hour."}
                    </p>
                </div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-[11px] uppercase tracking-wider text-gray-400 border-y border-gray-100 bg-gray-50/60">
                                <th className="text-left font-semibold px-6 py-2.5">Vehicle</th>
                                <th className="text-left font-semibold px-4 py-2.5">Location</th>
                                <th className="text-right font-semibold px-4 py-2.5">Silent for</th>
                                <th className="text-right font-semibold px-4 py-2.5">Battery</th>
                                <th className="text-right font-semibold px-4 py-2.5">GPS</th>
                                <th className="text-right font-semibold px-4 py-2.5">SOC</th>
                                <th className="text-right font-semibold px-6 py-2.5">Alerts</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                            {rows.map((r) => (
                                <tr key={r.vehicleno} className="hover:bg-gray-50/70">
                                    <td className="px-6 py-2.5 font-mono text-xs text-gray-900">
                                        {r.vehicleno}
                                    </td>
                                    <td className="px-4 py-2.5 text-gray-500 text-xs">
                                        {[r.city, r.state].filter(Boolean).join(", ") || (
                                            <span className="text-gray-300">unmapped</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-900 font-medium">
                                        {relativeAge(r.ageMs).replace(" ago", "")}
                                    </td>
                                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-500 text-xs">
                                        {relativeAge(r.lastBatteryAgeMs)}
                                    </td>
                                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-500 text-xs">
                                        {relativeAge(r.lastGpsAgeMs)}
                                    </td>
                                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-500">
                                        {r.soc_pct === null ? (
                                            <span className="text-gray-300">&mdash;</span>
                                        ) : (
                                            `${Math.round(r.soc_pct)}%`
                                        )}
                                    </td>
                                    <td className="px-6 py-2.5 text-right tabular-nums">
                                        {r.open_alert_count > 0 ? (
                                            <span className="text-amber-700 font-medium">
                                                {r.open_alert_count}
                                            </span>
                                        ) : (
                                            <span className="text-gray-300">0</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
