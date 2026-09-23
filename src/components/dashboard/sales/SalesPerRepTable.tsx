"use client";

// B7 row 4 (admin only) — one row per SPOC over the range, sortable on every
// numeric column via the shared TableSort, click a row to pin that rep.

import { useMemo } from "react";

import { SortableTh, sortRows, useTableSort, type SortSpec } from "@/components/shared/TableSort";
import type { InterestLevel, SalesSpocBlock } from "@/lib/admin/salesDashboardTypes";

const fmt = (n: number) => n.toLocaleString("en-IN");
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

type Row = {
    spoc_id: string;
    name: string;
    role: string;
    visits: number;
    unique_visits: number;
    new_visits: number;
    calls: number;
    hot: number;
    warm: number;
    cold: number;
    converted: number;
    quotes_issued: number;
    batteries_to_dealers: number;
    revenue: number;
    kyc_submitted: number;
};

const SPECS: SortSpec<Row>[] = [
    { key: "name", type: "text" },
    { key: "visits", type: "number" },
    { key: "unique_visits", type: "number" },
    { key: "new_visits", type: "number" },
    { key: "calls", type: "number" },
    { key: "hot", type: "number" },
    { key: "warm", type: "number" },
    { key: "cold", type: "number" },
    { key: "converted", type: "number" },
    { key: "quotes_issued", type: "number" },
    { key: "batteries_to_dealers", type: "number" },
    { key: "revenue", type: "number" },
    { key: "kyc_submitted", type: "number" },
];

function toRow(b: SalesSpocBlock): Row {
    const level = (l: InterestLevel) => b.interest.rows.find((r) => r.interest_level === l)?.total ?? 0;
    return {
        spoc_id: b.spoc_id,
        name: b.name ?? "(unknown user)",
        role: b.role ?? "",
        visits: b.totals.visits,
        unique_visits: b.totals.unique_visits,
        new_visits: b.totals.new_visits,
        calls: b.totals.calls,
        hot: level("hot"),
        warm: level("warm"),
        cold: level("cold"),
        converted: b.totals.converted,
        quotes_issued: b.outcome.quotes_issued,
        batteries_to_dealers: b.outcome.batteries_to_dealers,
        revenue: b.outcome.revenue,
        kyc_submitted: b.outcome.kyc_submitted,
    };
}

export function SalesPerRepTable({
    reps,
    onPick,
}: {
    reps: SalesSpocBlock[];
    onPick: (spocId: string) => void;
}) {
    const { sort, toggle, comparator } = useTableSort<Row>(SPECS);
    const rows = useMemo(() => sortRows(reps.map(toRow), comparator), [reps, comparator]);

    const num = (key: string, label: string) => (
        <SortableTh label={label} sortKey={key} sort={sort} onToggle={toggle} align="right" className="px-4" />
    );

    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="px-4 py-3">
                <h3 className="text-sm font-semibold text-ink">Per SPOC</h3>
                <p className="text-[11px] text-ink-muted">
                    Everyone with a visit, call, open lead, conversion or outcome in this range. Click a
                    row to see that person alone. Calls with no performer (the AI dialer) are in
                    the totals above but under no rep here.
                </p>
            </div>
            <div className="overflow-x-auto border-t border-border">
                <table className="w-full min-w-[1180px] text-sm">
                    <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                        <tr>
                            <SortableTh label="Name" sortKey="name" sort={sort} onToggle={toggle} className="px-4 text-left" />
                            {num("visits", "Visits")}
                            {num("unique_visits", "Unique")}
                            {num("new_visits", "New")}
                            {num("calls", "Calls")}
                            {num("hot", "Hot")}
                            {num("warm", "Warm")}
                            {num("cold", "Cold")}
                            {num("converted", "Converted")}
                            {num("quotes_issued", "Quotes")}
                            {num("batteries_to_dealers", "Batteries")}
                            {num("revenue", "Revenue")}
                            {num("kyc_submitted", "KYC")}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {rows.length === 0 && (
                            <tr>
                                <td colSpan={13} className="px-4 py-8 text-center text-ink-muted">
                                    No rep activity in this range.
                                </td>
                            </tr>
                        )}
                        {rows.map((r) => (
                            <tr
                                key={r.spoc_id}
                                onClick={() => onPick(r.spoc_id)}
                                tabIndex={0}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        onPick(r.spoc_id);
                                    }
                                }}
                                className="cursor-pointer transition hover:bg-brand-50/40 focus:outline-none focus-visible:bg-brand-50/60"
                                title={`Show only ${r.name}`}
                            >
                                <td className="px-4 py-2">
                                    <div className="font-medium text-ink">{r.name}</div>
                                    <div className="text-[11px] text-ink-muted">{r.role || "—"}</div>
                                </td>
                                <td className="px-4 py-2 text-right tabular-nums">{fmt(r.visits)}</td>
                                <td className="px-4 py-2 text-right tabular-nums">{fmt(r.unique_visits)}</td>
                                <td className="px-4 py-2 text-right tabular-nums">{fmt(r.new_visits)}</td>
                                <td className="px-4 py-2 text-right tabular-nums">{fmt(r.calls)}</td>
                                <td className="px-4 py-2 text-right tabular-nums">{fmt(r.hot)}</td>
                                <td className="px-4 py-2 text-right tabular-nums">{fmt(r.warm)}</td>
                                <td className="px-4 py-2 text-right tabular-nums">{fmt(r.cold)}</td>
                                <td className="px-4 py-2 text-right tabular-nums">{fmt(r.converted)}</td>
                                <td className="px-4 py-2 text-right tabular-nums">{fmt(r.quotes_issued)}</td>
                                <td className="px-4 py-2 text-right tabular-nums">{fmt(r.batteries_to_dealers)}</td>
                                <td className="px-4 py-2 text-right tabular-nums">{inr(r.revenue)}</td>
                                <td className="px-4 py-2 text-right tabular-nums">{fmt(r.kyc_submitted)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
