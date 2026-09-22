"use client";

// Generic report table — renders any ReportResult (columns + rows). When the
// result declares `drill`, non-zero cells in the drill columns open the list of
// leads behind the number.

import { useState } from "react";
import { Inbox } from "lucide-react";
import type { ReportResult } from "@/lib/admin/types";
import { DrillLeadsModal, type DrillTarget } from "./DrillLeadsModal";

export function ReportTable({ result, qs = "" }: { result: ReportResult; qs?: string }) {
    const [drill, setDrill] = useState<DrillTarget | null>(null);

    if (result.rows.length === 0) {
        return (
            <div className="py-12 text-center text-ink-muted">
                <Inbox className="h-8 w-8 mx-auto mb-2" />
                No data for this report and date range.
            </div>
        );
    }

    const drillMetrics = new Set(result.drill?.metrics ?? []);

    return (
        <div className="overflow-x-auto">
            <table className="w-full text-sm">
                <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                    <tr>
                        {result.columns.map((c) => (
                            <th
                                key={c.key}
                                className={`px-4 py-2.5 font-semibold ${
                                    c.numeric ? "text-right" : "text-left"
                                }`}
                            >
                                {c.label}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody className="divide-y divide-border">
                    {result.rows.map((row, i) => (
                        <tr key={i} className="hover:bg-bg/60">
                            {result.columns.map((c) => {
                                const v = row[c.key];
                                const drillId = result.drill ? row[result.drill.idKey] : null;
                                const canDrill =
                                    drillMetrics.has(c.key) &&
                                    drillId != null &&
                                    typeof v === "number" &&
                                    v > 0;
                                return (
                                    <td
                                        key={c.key}
                                        className={`px-4 py-2.5 ${
                                            c.numeric
                                                ? "text-right tabular-nums text-ink"
                                                : "text-left text-ink"
                                        }`}
                                    >
                                        {canDrill ? (
                                            <button
                                                type="button"
                                                title={`View ${v} lead${v === 1 ? "" : "s"}`}
                                                onClick={() =>
                                                    setDrill({
                                                        personId: String(drillId),
                                                        personName: String(row.person ?? ""),
                                                        metric: c.key,
                                                        metricLabel: c.label,
                                                        count: v,
                                                    })
                                                }
                                                className="font-semibold text-brand-600 underline decoration-dotted underline-offset-4 hover:decoration-solid"
                                            >
                                                {v}
                                            </button>
                                        ) : v == null || v === "" ? (
                                            "—"
                                        ) : (
                                            String(v)
                                        )}
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
            {drill && (
                <DrillLeadsModal target={drill} qs={qs} onClose={() => setDrill(null)} />
            )}
        </div>
    );
}
