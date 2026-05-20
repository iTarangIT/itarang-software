"use client";

// Generic report table — renders any ReportResult (columns + rows).

import { Inbox } from "lucide-react";
import type { ReportResult } from "@/lib/admin/types";

export function ReportTable({ result }: { result: ReportResult }) {
    if (result.rows.length === 0) {
        return (
            <div className="py-12 text-center text-ink-muted">
                <Inbox className="h-8 w-8 mx-auto mb-2" />
                No data for this report and date range.
            </div>
        );
    }

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
                                return (
                                    <td
                                        key={c.key}
                                        className={`px-4 py-2.5 ${
                                            c.numeric
                                                ? "text-right tabular-nums text-ink"
                                                : "text-left text-ink"
                                        }`}
                                    >
                                        {v == null || v === "" ? "—" : String(v)}
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
