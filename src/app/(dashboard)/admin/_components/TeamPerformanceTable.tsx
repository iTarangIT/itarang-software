"use client";

// BRD §0.11 Zone 2 — one row per IS Rep / ASM. Sortable on any column;
// default sort is Critical Stale desc so bottlenecks surface first.

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { TeamPerfRow } from "@/lib/admin/types";

type SortKey =
    | "user_name"
    | "open_leads"
    | "touchpoints_today"
    | "touchpoints_week"
    | "avg_touchpoints_per_lead"
    | "avg_time_to_first_touch_hours"
    | "conversion_rate_30d"
    | "stale_leads"
    | "critical_stale";

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
    { key: "user_name", label: "Rep / ASM", numeric: false },
    { key: "open_leads", label: "Open", numeric: true },
    { key: "touchpoints_today", label: "TP Today", numeric: true },
    { key: "touchpoints_week", label: "TP Week", numeric: true },
    { key: "avg_touchpoints_per_lead", label: "Avg TP/Lead", numeric: true },
    { key: "avg_time_to_first_touch_hours", label: "Avg 1st Touch", numeric: true },
    { key: "conversion_rate_30d", label: "Conv % (30d)", numeric: true },
    { key: "stale_leads", label: "Stale >5d", numeric: true },
    { key: "critical_stale", label: "Critical >10d", numeric: true },
];

function cell(key: SortKey, row: TeamPerfRow): string {
    const v = row[key];
    if (v == null) return "—";
    if (key === "conversion_rate_30d") return `${Math.round(Number(v) * 100)}%`;
    if (key === "avg_time_to_first_touch_hours") return `${Number(v).toFixed(1)}h`;
    return String(v);
}

export function TeamPerformanceTable({ rows }: { rows: TeamPerfRow[] }) {
    const [sortKey, setSortKey] = useState<SortKey>("critical_stale");
    const [asc, setAsc] = useState(false);

    const sorted = useMemo(() => {
        const copy = [...rows];
        copy.sort((a, b) => {
            const av = a[sortKey];
            const bv = b[sortKey];
            if (av == null && bv == null) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            if (typeof av === "number" && typeof bv === "number") {
                return asc ? av - bv : bv - av;
            }
            return asc
                ? String(av).localeCompare(String(bv))
                : String(bv).localeCompare(String(av));
        });
        return copy;
    }, [rows, sortKey, asc]);

    function toggleSort(key: SortKey) {
        if (key === sortKey) setAsc((v) => !v);
        else {
            setSortKey(key);
            setAsc(key === "user_name");
        }
    }

    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                <Users className="h-4 w-4 text-brand-600" />
                <h2 className="text-sm font-semibold text-brand-navy">
                    Team Performance
                </h2>
                <span className="text-xs text-ink-muted">({rows.length})</span>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead className="bg-bg text-[11px] uppercase tracking-wide text-ink-muted">
                        <tr>
                            {COLUMNS.map((c) => (
                                <th
                                    key={c.key}
                                    onClick={() => toggleSort(c.key)}
                                    className={cn(
                                        "cursor-pointer select-none px-3 py-2.5 font-semibold transition-colors hover:text-ink",
                                        c.numeric ? "text-right" : "text-left",
                                    )}
                                >
                                    <span className="inline-flex items-center gap-1">
                                        {c.label}
                                        {sortKey === c.key &&
                                            (asc ? (
                                                <ArrowUp className="h-3 w-3 text-brand-sky" />
                                            ) : (
                                                <ArrowDown className="h-3 w-3 text-brand-sky" />
                                            ))}
                                    </span>
                                </th>
                            ))}
                            <th className="px-3 py-2.5 text-left font-semibold">
                                OOO
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {sorted.length === 0 && (
                            <tr>
                                <td
                                    colSpan={COLUMNS.length + 1}
                                    className="px-4 py-10 text-center text-ink-muted"
                                >
                                    No active reps or ASMs.
                                </td>
                            </tr>
                        )}
                        {sorted.map((r) => (
                            <tr
                                key={r.user_id}
                                className="transition-colors hover:bg-bg/60"
                            >
                                <td className="px-3 py-2.5">
                                    <div className="font-medium text-ink">
                                        {r.user_name ?? "(unnamed)"}
                                    </div>
                                    <div className="text-[11px] text-ink-muted">
                                        {r.role}
                                    </div>
                                </td>
                                {COLUMNS.slice(1).map((c) => {
                                    const critical =
                                        c.key === "critical_stale" &&
                                        r.critical_stale > 0;
                                    const stale =
                                        c.key === "stale_leads" &&
                                        r.stale_leads > 0;
                                    return (
                                        <td
                                            key={c.key}
                                            className={cn(
                                                "px-3 py-2.5 text-right tabular-nums",
                                                critical
                                                    ? "font-semibold text-danger"
                                                    : stale
                                                      ? "text-warning"
                                                      : "text-ink",
                                            )}
                                        >
                                            {cell(c.key, r)}
                                        </td>
                                    );
                                })}
                                <td className="px-3 py-2.5">
                                    {r.ooo_status ? (
                                        <Badge variant="warning" uppercase>
                                            OOO
                                        </Badge>
                                    ) : (
                                        <span className="text-[11px] text-ink-muted">
                                            Active
                                        </span>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
