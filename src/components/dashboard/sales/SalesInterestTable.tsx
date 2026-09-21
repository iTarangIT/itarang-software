"use client";

// B7 row 3 — hot / warm / cold with the four ageing buckets.

import type { InterestSection } from "@/lib/admin/salesDashboardTypes";

const fmt = (n: number) => n.toLocaleString("en-IN");

const LEVEL_TONE: Record<string, string> = {
    hot: "border-rose-200 bg-rose-50 text-rose-700",
    warm: "border-amber-200 bg-amber-50 text-amber-700",
    cold: "border-sky-200 bg-sky-50 text-sky-700",
};

export function SalesInterestTable({ d }: { d: InterestSection }) {
    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="px-4 py-3">
                <h3 className="text-sm font-semibold text-ink">Hot / warm / cold, by age</h3>
                <p
                    className="text-[11px] text-ink-muted"
                    title={`Measured on ${d.ageing_basis}`}
                >
                    Open leads by interest level and how many days they have held that
                    rating. Calls, visits and edits do not reset it — only a change of
                    rating does.
                </p>
            </div>
            <div className="overflow-x-auto border-t border-border">
                <table className="w-full min-w-[520px] text-sm">
                    <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                        <tr>
                            <th className="px-4 py-2 text-left font-semibold">Level</th>
                            <th className="px-4 py-2 text-right font-semibold">Total</th>
                            <th className="px-4 py-2 text-right font-semibold">0–7 d</th>
                            <th className="px-4 py-2 text-right font-semibold">8–14 d</th>
                            <th className="px-4 py-2 text-right font-semibold">15–30 d</th>
                            <th className="px-4 py-2 text-right font-semibold">30+ d</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {d.rows.map((r) => (
                            <tr key={r.interest_level}>
                                <td className="px-4 py-2">
                                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize ${LEVEL_TONE[r.interest_level]}`}>
                                        {r.interest_level}
                                    </span>
                                </td>
                                <td className="px-4 py-2 text-right font-semibold tabular-nums text-ink">{fmt(r.total)}</td>
                                <td className="px-4 py-2 text-right tabular-nums">{fmt(r.age_0_7)}</td>
                                <td className="px-4 py-2 text-right tabular-nums">{fmt(r.age_8_14)}</td>
                                <td className="px-4 py-2 text-right tabular-nums">{fmt(r.age_15_30)}</td>
                                <td className="px-4 py-2 text-right tabular-nums">{fmt(r.age_30_plus)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
