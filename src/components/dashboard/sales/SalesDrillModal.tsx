"use client";

// The popup behind a number on the Sales dashboard: who / what it counts, with
// "Download CSV". Two sources:
//   query  — /api/admin/reports/sales-drill (src/lib/dashboard/salesDrill.ts),
//            the first 500 rows here, every row in the CSV
//   rows   — rows the page already holds (Accounts by owner); the CSV is built
//            here from the same rows

import { useEffect } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Download, Inbox, Loader2, X } from "lucide-react";

import type { DrillRow } from "@/lib/dashboard/salesDrill";
import { LEAD_STATUS_LABEL } from "@/lib/leads/queueFilters";

export type SalesDrillTarget = {
    title: string;
    /** The number that was clicked. */
    count: number;
} & (
    | { query: string; rows?: undefined; csvName?: undefined }
    | { query?: undefined; rows: DrillRow[]; csvName: string }
);

const pretty = (v: string | null | undefined) => (v ? v.replace(/_/g, " ") : "");
const statusText = (v: string | null) => (v && (LEAD_STATUS_LABEL as Record<string, string>)[v]) || pretty(v) || "—";

function fmtWhen(v: string | null): string {
    if (!v) return "—";
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The same columns as the server CSV, for rows the page already has. */
function downloadRows(rows: DrillRow[], name: string) {
    const head = ["Person (counted for)", "ID", "Name", "Phone", "City", "State", "Status", "Rating", "Current owner / dealer", "When", "Detail"];
    const lines = [
        head.map(esc).join(","),
        ...rows.map((r) =>
            [r.person_name ?? "", r.id, r.name, r.phone ?? "", r.city ?? "", r.state ?? "", statusText(r.status), r.rating ?? "", r.owner_name ?? "", r.at ?? "", r.detail ?? ""]
                .map(esc)
                .join(","),
        ),
    ];
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
}

export function SalesDrillModal({ target, onClose }: { target: SalesDrillTarget; onClose: () => void }) {
    const q = useQuery<{ rows: DrillRow[] }>({
        queryKey: ["sales-drill", target.query],
        enabled: Boolean(target.query),
        queryFn: async () => {
            const res = await fetch(`/api/admin/reports/sales-drill?${target.query}`, { cache: "no-store" });
            const json = await res.json().catch(() => null);
            if (!res.ok || !json?.success) throw new Error(json?.error?.message ?? "Could not load the list");
            return json.data;
        },
    });
    const rows = target.rows ?? q.data?.rows ?? [];
    const loading = Boolean(target.query) && q.isLoading;
    const csvHref = target.query ? `/api/admin/reports/sales-drill?${target.query}&format=csv` : null;
    const showPerson = rows.some((r) => r.person_name) && new Set(rows.map((r) => r.person_id)).size > 1;

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
        document.addEventListener("keydown", onKey);
        const prev = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            document.removeEventListener("keydown", onKey);
            document.body.style.overflow = prev;
        };
    }, [onClose]);

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
            <div role="dialog" aria-modal="true" className="relative flex max-h-[85vh] w-full max-w-5xl flex-col rounded-2xl bg-surface shadow-2xl ring-1 ring-black/5">
                <div className="flex items-start gap-4 border-b border-border px-5 py-4">
                    <div className="min-w-0">
                        <h3 className="text-base font-bold text-ink">{target.title}</h3>
                        <p className="mt-0.5 text-xs text-ink-muted">
                            {target.count} {target.count === 1 ? "row" : "rows"}
                            {!loading && rows.length >= 500 && target.count > rows.length
                                ? ` · showing the first ${rows.length} — download the CSV for all`
                                : ""}
                        </p>
                    </div>
                    {csvHref ? (
                        <a href={csvHref} download className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-brand-navy hover:bg-bg">
                            <Download className="h-3.5 w-3.5" aria-hidden /> Download CSV
                        </a>
                    ) : (
                        <button
                            type="button"
                            onClick={() => downloadRows(rows, target.csvName ?? "list")}
                            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-brand-navy hover:bg-bg"
                        >
                            <Download className="h-3.5 w-3.5" aria-hidden /> Download CSV
                        </button>
                    )}
                    <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-ink-muted hover:bg-bg">
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <div className="overflow-auto">
                    {loading && (
                        <div className="flex items-center justify-center py-12 text-ink-muted">
                            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
                        </div>
                    )}
                    {q.error && (
                        <div className="flex items-center gap-2 p-4 text-sm text-danger">
                            <AlertTriangle className="h-4 w-4" /> {(q.error as Error).message}
                        </div>
                    )}
                    {!loading && !q.error && rows.length === 0 && (
                        <div className="py-12 text-center text-ink-muted">
                            <Inbox className="mx-auto mb-2 h-8 w-8" /> Nothing to show.
                        </div>
                    )}
                    {rows.length > 0 && (
                        <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-bg text-[11px] uppercase tracking-wide text-ink-muted">
                                <tr>
                                    {showPerson && <th className="px-4 py-2.5 text-left font-semibold">Person</th>}
                                    <th className="px-4 py-2.5 text-left font-semibold">Name</th>
                                    <th className="px-4 py-2.5 text-left font-semibold">Phone</th>
                                    <th className="px-4 py-2.5 text-left font-semibold">Region</th>
                                    <th className="px-4 py-2.5 text-left font-semibold">Status</th>
                                    <th className="px-4 py-2.5 text-left font-semibold">When</th>
                                    <th className="px-4 py-2.5 text-left font-semibold">Detail</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {rows.map((r, i) => (
                                    <tr key={`${r.id}-${r.at}-${i}`} className="align-top hover:bg-bg/60">
                                        {showPerson && <td className="px-4 py-2.5 text-ink">{r.person_name ?? "—"}</td>}
                                        <td className="px-4 py-2.5">
                                            {r.href ? (
                                                <Link href={r.href} target="_blank" className="font-medium text-brand-600 hover:underline">
                                                    {r.name}
                                                </Link>
                                            ) : (
                                                <span className="font-medium text-ink">{r.name}</span>
                                            )}
                                            {r.owner_name && <div className="text-xs text-ink-muted">{r.owner_name}</div>}
                                        </td>
                                        <td className="px-4 py-2.5 tabular-nums text-ink">{r.phone || "—"}</td>
                                        <td className="px-4 py-2.5 text-ink">{[r.city, r.state].filter(Boolean).join(", ") || "—"}</td>
                                        <td className="px-4 py-2.5 text-ink">
                                            {statusText(r.status)}
                                            {r.rating && <span className="block text-xs capitalize text-ink-muted">{r.rating}</span>}
                                        </td>
                                        <td className="whitespace-nowrap px-4 py-2.5 text-ink">{fmtWhen(r.at)}</td>
                                        <td className="max-w-[22rem] px-4 py-2.5 text-xs text-ink-muted">{r.detail || "—"}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>
        </div>
    );
}
