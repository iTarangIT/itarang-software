"use client";

// Tracker ID 5 — "My dealers": Dealer Health's rows for the accounts the
// signed-in user owns, with "Order placed" and their own
// "Order claimed, no invoice raised" list.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import {
    ACCOUNT_BUCKETS,
    ACCOUNT_BUCKET_LABELS,
    type AccountBucket,
} from "@/lib/dealers/accountHealthRules";
import type { DealerHealthRow } from "@/lib/dealers/accountHealth";
import { OrderClaimBadge, OrderClaimsList, OrderPlacedButton } from "@/components/accounts/OrderClaims";

const BUCKET_TONE: Record<AccountBucket, string> = {
    active: "bg-emerald-50 text-emerald-700 border-emerald-200",
    cooling: "bg-sky-50 text-sky-700 border-sky-200",
    orange: "bg-orange-50 text-orange-700 border-orange-200",
    red: "bg-rose-50 text-rose-700 border-rose-200",
    dormant: "bg-slate-100 text-slate-700 border-slate-300",
    not_ordered_yet: "bg-white text-slate-600 border-slate-200",
    never_ordered: "bg-amber-50 text-amber-800 border-amber-200",
    closed: "bg-gray-800 text-white border-gray-800",
};

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

/** Most urgent first: Orange, Red, Dormant, then the rest. */
const URGENCY: AccountBucket[] = ["orange", "red", "dormant", "cooling", "never_ordered", "not_ordered_yet", "active", "closed"];

export function MyDealersView() {
    const [bucket, setBucket] = useState<AccountBucket | "">("");
    const { data, isLoading, error } = useQuery<{ rows: DealerHealthRow[]; can_record_orders: boolean }>({
        queryKey: ["my-dealers"],
        queryFn: async () => {
            const res = await fetch("/api/dealer-accounts/mine", { cache: "no-store" });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? "Could not load your dealers");
            return json.data;
        },
    });

    if (isLoading) {
        return (
            <div className="flex items-center gap-2 text-sm text-ink-muted">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
        );
    }
    if (error) return <p className="text-sm text-rose-600">{(error as Error).message}</p>;

    const rows = [...(data?.rows ?? [])].sort(
        (a, b) =>
            URGENCY.indexOf(a.bucket) - URGENCY.indexOf(b.bucket) ||
            (b.days_since_last_order ?? 0) - (a.days_since_last_order ?? 0),
    );
    const counts = Object.fromEntries(ACCOUNT_BUCKETS.map((b) => [b, rows.filter((r) => r.bucket === b).length])) as Record<
        AccountBucket,
        number
    >;
    const visible = bucket ? rows.filter((r) => r.bucket === bucket) : rows;

    if (rows.length === 0) {
        return (
            <p className="rounded-xl border border-border bg-surface px-4 py-8 text-center text-sm text-ink-muted">
                No dealer accounts are assigned to you yet. Your Sales Head assigns owners on the Accounts page.
            </p>
        );
    }

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
                {ACCOUNT_BUCKETS.filter((b) => counts[b] > 0).map((b) => (
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

            <div className="rounded-xl border border-border bg-surface shadow-card overflow-x-auto">
                <table className="w-full min-w-[900px] text-sm">
                    <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                        <tr>
                            <th className="px-3 py-2 text-left font-semibold">Dealer</th>
                            <th className="px-3 py-2 text-left font-semibold">Bucket</th>
                            <th className="px-3 py-2 text-left font-semibold">Last invoice</th>
                            <th className="px-3 py-2 text-right font-semibold">Days since</th>
                            <th className="px-3 py-2 text-right font-semibold">Usual gap (d)</th>
                            <th className="px-3 py-2 text-right font-semibold">Revenue 90d</th>
                            <th className="px-3 py-2 text-right font-semibold">Lifetime</th>
                            {data?.can_record_orders && <th className="px-3 py-2" />}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {visible.map((r) => (
                            <tr key={r.key}>
                                <td className="px-3 py-2">
                                    <span className="font-medium text-ink">{r.dealer}</span>
                                    <div className="text-[11px] text-ink-muted">
                                        {[r.city, r.gstin ?? "no GSTIN"].filter(Boolean).join(" · ")}
                                    </div>
                                </td>
                                <td className="px-3 py-2">
                                    <span className={`rounded-full border px-2 py-0.5 text-[11px] ${BUCKET_TONE[r.bucket]}`}>
                                        {ACCOUNT_BUCKET_LABELS[r.bucket].split(" (")[0]}
                                    </span>
                                    {r.closed_reason && <div className="mt-1 text-[11px] text-ink-muted">{r.closed_reason}</div>}
                                    {r.order_claim && <OrderClaimBadge claim={r.order_claim} />}
                                </td>
                                <td className="px-3 py-2 text-ink-muted">{r.last_order ?? "—"}</td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                    {r.days_since_last_order ?? r.days_since_conversion ?? "—"}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">{r.avg_reorder_days ?? "—"}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{inr(r.revenue_90d)}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{inr(r.revenue_lifetime)}</td>
                                {data?.can_record_orders && (
                                    <td className="px-3 py-2 text-right">
                                        {r.account_id && r.bucket !== "closed" && !r.order_claim && (
                                            <OrderPlacedButton accountId={r.account_id} />
                                        )}
                                    </td>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {data?.can_record_orders && <OrderClaimsList canWithdraw mine title="My orders with no invoice raised" />}
        </div>
    );
}
