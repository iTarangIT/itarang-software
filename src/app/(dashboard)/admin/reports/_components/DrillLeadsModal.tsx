"use client";

// Funnel-by-Owner drill-down — the leads behind one clicked number.

import { useEffect } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Inbox, Loader2, X } from "lucide-react";
import type { OwnerDrillLead } from "@/lib/admin/types";

export type DrillTarget = {
    personId: string;
    personName: string;
    metric: string;
    metricLabel: string;
    count: number;
};

function fmtDate(v: string | null): string {
    if (!v) return "—";
    const d = new Date(v);
    return Number.isNaN(d.getTime())
        ? "—"
        : d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

export function DrillLeadsModal({
    target,
    qs,
    onClose,
}: {
    target: DrillTarget;
    /** The report's date-range query string, so the list uses the same period. */
    qs: string;
    onClose: () => void;
}) {
    const params = new URLSearchParams(qs);
    params.set("person_id", target.personId);
    params.set("metric", target.metric);

    const query = useQuery<{ success: true; data: { leads: OwnerDrillLead[] } }>({
        queryKey: ["admin-report-owner-leads", target.personId, target.metric, qs],
        queryFn: async () => {
            const res = await fetch(`/api/admin/reports/owner-leads?${params}`, {
                cache: "no-store",
            });
            if (!res.ok) throw new Error("Failed to load leads");
            return res.json();
        },
    });
    const leads = query.data?.data.leads ?? [];

    // Escape closes; body scroll locked while open (same as confirm-dialog).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
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
            <div
                className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
                onClick={onClose}
            />
            <div
                role="dialog"
                aria-modal="true"
                className="relative w-full max-w-4xl max-h-[85vh] flex flex-col rounded-2xl bg-surface shadow-2xl ring-1 ring-black/5"
            >
                <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-border">
                    <div>
                        <h3 className="text-base font-bold text-ink">
                            {target.personName} — {target.metricLabel}
                        </h3>
                        <p className="text-xs text-ink-muted mt-0.5">
                            {target.count} lead{target.count === 1 ? "" : "s"}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="rounded-md p-1 text-ink-muted hover:bg-bg"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <div className="overflow-auto">
                    {query.isLoading && (
                        <div className="flex items-center justify-center py-12 text-ink-muted">
                            <Loader2 className="h-5 w-5 animate-spin mr-2" />
                            Loading leads…
                        </div>
                    )}
                    {query.error && (
                        <div className="flex items-center gap-2 p-4 text-sm text-danger">
                            <AlertTriangle className="h-4 w-4" />
                            {(query.error as Error).message}
                        </div>
                    )}
                    {query.data && leads.length === 0 && (
                        <div className="py-12 text-center text-ink-muted">
                            <Inbox className="h-8 w-8 mx-auto mb-2" />
                            No leads to show.
                        </div>
                    )}
                    {leads.length > 0 && (
                        <table className="w-full text-sm">
                            <thead className="sticky top-0 bg-bg text-[11px] uppercase tracking-wide text-ink-muted">
                                <tr>
                                    <th className="px-4 py-2.5 text-left font-semibold">Dealer / Shop</th>
                                    <th className="px-4 py-2.5 text-left font-semibold">Phone</th>
                                    <th className="px-4 py-2.5 text-left font-semibold">Region</th>
                                    <th className="px-4 py-2.5 text-left font-semibold">Status</th>
                                    <th className="px-4 py-2.5 text-left font-semibold">Rating / AI band</th>
                                    <th className="px-4 py-2.5 text-left font-semibold">Last touch</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {leads.map((l) => {
                                    const name = l.shop_name || l.dealer_name || l.id;
                                    return (
                                        <tr key={l.id} className="hover:bg-bg/60">
                                            <td className="px-4 py-2.5">
                                                <Link
                                                    href={`/inside-sales/lead/${encodeURIComponent(l.id)}`}
                                                    target="_blank"
                                                    className="font-medium text-brand-600 hover:underline"
                                                >
                                                    {name}
                                                </Link>
                                                {l.dealer_name && l.shop_name && l.dealer_name !== l.shop_name && (
                                                    <div className="text-xs text-ink-muted">{l.dealer_name}</div>
                                                )}
                                            </td>
                                            <td className="px-4 py-2.5 tabular-nums text-ink">{l.phone || "—"}</td>
                                            <td className="px-4 py-2.5 text-ink">
                                                {[l.city, l.state].filter(Boolean).join(", ") || "—"}
                                            </td>
                                            <td className="px-4 py-2.5 text-ink">
                                                {l.lead_status?.replace(/_/g, " ") || "—"}
                                            </td>
                                            <td className="px-4 py-2.5 text-ink capitalize">
                                                {l.interest_level || "—"} / {l.current_status || "—"}
                                            </td>
                                            <td className="px-4 py-2.5 text-ink whitespace-nowrap">
                                                {fmtDate(l.last_touchpoint_at)}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>
        </div>
    );
}
