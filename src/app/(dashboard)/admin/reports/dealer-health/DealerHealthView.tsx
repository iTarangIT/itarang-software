"use client";

// R-18 — Section A (dealer list, filterable by bucket) and Section C (summary
// by SPOC / city / business type with reorder rate) of the review's sheet 7.

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import {
    ACCOUNT_BUCKETS,
    ACCOUNT_BUCKET_LABELS,
    type AccountBucket,
} from "@/lib/dealers/accountHealthRules";
import type { DealerHealthGroup, DealerHealthRow } from "@/lib/dealers/accountHealth";

type Group = "owner" | "city" | "business_type";

const BUCKET_TONE: Record<AccountBucket, string> = {
    active: "bg-emerald-50 text-emerald-700 border-emerald-200",
    cooling: "bg-sky-50 text-sky-700 border-sky-200",
    orange: "bg-orange-50 text-orange-700 border-orange-200",
    red: "bg-rose-50 text-rose-700 border-rose-200",
    dormant: "bg-slate-100 text-slate-700 border-slate-300",
    not_ordered_yet: "bg-white text-slate-600 border-slate-200",
    never_ordered: "bg-amber-50 text-amber-800 border-amber-200",
};

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const pct = (r: number | null) => (r == null ? "—" : `${Math.round(r * 100)}%`);

export function DealerHealthView() {
    const [group, setGroup] = useState<Group>("owner");
    const [bucket, setBucket] = useState<AccountBucket | "">("");

    const { data, isLoading, error } = useQuery<{
        rows: DealerHealthRow[];
        summary: DealerHealthGroup[];
    }>({
        queryKey: ["dealer-health", group],
        queryFn: async () => {
            const res = await fetch(`/api/admin/dealer-health?group=${group}`, { cache: "no-store" });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? "Could not load dealer health");
            return json.data;
        },
        placeholderData: (prev) => prev,
    });

    if (isLoading && !data) {
        return (
            <div className="flex items-center gap-2 text-sm text-ink-muted">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
        );
    }
    if (error) return <p className="text-sm text-rose-600">{(error as Error).message}</p>;

    const rows = data?.rows ?? [];
    const counts = Object.fromEntries(
        ACCOUNT_BUCKETS.map((b) => [b, rows.filter((r) => r.bucket === b).length]),
    ) as Record<AccountBucket, number>;
    const visible = bucket ? rows.filter((r) => r.bucket === bucket) : rows;
    const noGstin = rows.filter((r) => !r.gstin).length;

    return (
        <div className="space-y-5">
            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    onClick={() => setBucket("")}
                    className={`rounded-full border px-3 py-1 text-xs font-medium ${bucket === "" ? "bg-ink text-white border-ink" : "border-border text-ink"}`}
                >
                    All · {rows.length}
                </button>
                {ACCOUNT_BUCKETS.map((b) => (
                    <button
                        key={b}
                        type="button"
                        onClick={() => setBucket(b)}
                        className={`rounded-full border px-3 py-1 text-xs font-medium ${BUCKET_TONE[b]} ${bucket === b ? "ring-2 ring-offset-1 ring-ink/40" : ""}`}
                    >
                        {ACCOUNT_BUCKET_LABELS[b]} · {counts[b]}
                    </button>
                ))}
            </div>

            {noGstin > 0 && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    {noGstin} of {rows.length} converted dealers have no GSTIN on their lead, so none of
                    their invoices can be seen here. GSTIN is now required at Mark Converted; older leads
                    can have it added from the lead&apos;s contact details.
                </p>
            )}

            <div className="rounded-xl border border-border bg-surface shadow-card overflow-x-auto">
                <table className="w-full min-w-[1100px] text-sm">
                    <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                        <tr>
                            <th className="px-3 py-2 text-left font-semibold">Dealer</th>
                            <th className="px-3 py-2 text-left font-semibold">Owner</th>
                            <th className="px-3 py-2 text-left font-semibold">Bucket</th>
                            <th className="px-3 py-2 text-left font-semibold">Converted</th>
                            <th className="px-3 py-2 text-left font-semibold">Last order</th>
                            <th className="px-3 py-2 text-right font-semibold">Days since</th>
                            <th className="px-3 py-2 text-right font-semibold">Orders</th>
                            <th className="px-3 py-2 text-right font-semibold">Revenue 90d</th>
                            <th className="px-3 py-2 text-right font-semibold">Lifetime</th>
                            <th className="px-3 py-2 text-right font-semibold">Avg reorder (d)</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {visible.length === 0 && (
                            <tr>
                                <td colSpan={10} className="px-3 py-8 text-center text-ink-muted">
                                    No dealers in this bucket.
                                </td>
                            </tr>
                        )}
                        {visible.map((r) => (
                            <tr key={r.lead_id}>
                                <td className="px-3 py-2">
                                    <Link href={`/leads/${encodeURIComponent(r.lead_id)}`} className="font-medium text-ink hover:underline">
                                        {r.dealer}
                                    </Link>
                                    <div className="text-[11px] text-ink-muted">
                                        {[r.city, r.gstin ?? "no GSTIN"].filter(Boolean).join(" · ")}
                                    </div>
                                </td>
                                <td className="px-3 py-2 text-ink">{r.owner_name ?? "—"}</td>
                                <td className="px-3 py-2">
                                    <span className={`rounded-full border px-2 py-0.5 text-[11px] ${BUCKET_TONE[r.bucket]}`}>
                                        {ACCOUNT_BUCKET_LABELS[r.bucket].split(" (")[0]}
                                    </span>
                                </td>
                                <td className="px-3 py-2 text-ink-muted">{r.converted_on ?? "—"}</td>
                                <td className="px-3 py-2 text-ink-muted">{r.last_order ?? "—"}</td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                    {r.days_since_last_order ?? r.days_since_conversion ?? "—"}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">{r.orders}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{inr(r.revenue_90d)}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{inr(r.revenue_lifetime)}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{r.avg_reorder_days ?? "—"}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div className="rounded-xl border border-border bg-surface shadow-card">
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div>
                        <h2 className="text-sm font-semibold text-ink">Summary</h2>
                        <p className="text-[11px] text-ink-muted">
                            Reorder rate = dealers who ordered in the last 30 days and also before ÷ dealers
                            who had ordered before. ₹ at risk = last-90-day revenue of Red and Dormant dealers.
                        </p>
                    </div>
                    <select
                        value={group}
                        onChange={(e) => setGroup(e.target.value as Group)}
                        className="rounded-lg border border-border bg-surface px-2 py-1 text-sm"
                    >
                        <option value="owner">By owner</option>
                        <option value="city">By city</option>
                        <option value="business_type">By business type</option>
                    </select>
                </div>
                <div className="overflow-x-auto border-t border-border">
                    <table className="w-full min-w-[1000px] text-sm">
                        <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                            <tr>
                                <th className="px-3 py-2 text-left font-semibold">Group</th>
                                <th className="px-3 py-2 text-right font-semibold">Dealers</th>
                                {ACCOUNT_BUCKETS.map((b) => (
                                    <th key={b} className="px-3 py-2 text-right font-semibold">
                                        {ACCOUNT_BUCKET_LABELS[b].split(" (")[0].split(" —")[0]}
                                    </th>
                                ))}
                                <th className="px-3 py-2 text-right font-semibold">Reorder rate</th>
                                <th className="px-3 py-2 text-right font-semibold">Revenue 90d</th>
                                <th className="px-3 py-2 text-right font-semibold">₹ at risk</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {(data?.summary ?? []).map((g) => (
                                <tr key={g.group}>
                                    <td className="px-3 py-2 font-medium text-ink">{g.group}</td>
                                    <td className="px-3 py-2 text-right tabular-nums">{g.dealers}</td>
                                    {ACCOUNT_BUCKETS.map((b) => (
                                        <td key={b} className="px-3 py-2 text-right tabular-nums">{g.by_bucket[b]}</td>
                                    ))}
                                    <td className="px-3 py-2 text-right tabular-nums">{pct(g.reorder_rate)}</td>
                                    <td className="px-3 py-2 text-right tabular-nums">{inr(g.revenue_90d)}</td>
                                    <td className="px-3 py-2 text-right tabular-nums">{inr(g.at_risk_90d)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
