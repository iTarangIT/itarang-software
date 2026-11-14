"use client";

// Tracker ID 5 — "My dealers": Dealer Health's rows for the accounts the
// signed-in user owns, with "Order placed" and their own
// "Order claimed, no invoice raised" list.
// E-358: an ASM also sees their team's accounts, Sales Head / CEO / Partner
// every account; each dealer opens its account page (account quotations).

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Loader2, MapPin } from "lucide-react";

import {
    ACCOUNT_BUCKETS,
    ACCOUNT_BUCKET_LABELS,
    type AccountBucket,
} from "@/lib/dealers/accountHealthRules";
import type { DealerHealthRow } from "@/lib/dealers/accountHealth";
import { OrderClaimBadge, OrderClaimsList, OrderPlacedButton } from "@/components/accounts/OrderClaims";
import { InfoTip } from "@/components/ui/info-tip";

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

type MyDealerRow = DealerHealthRow & {
    scope: "own" | "team" | "other";
    can_log_visit: boolean;
    /** ID 241-3: the latest done visit (IST date) and the 30-day flag, from /api/dealer-accounts/mine. */
    last_visit_date?: string | null;
    not_visited_30?: boolean;
};
type Whose = "" | "own" | "team" | "other";

const DAY_MONTH = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
/** "12 Aug" (a calendar date, shown as stored). */
function lastVisitLabel(d: string): string {
    const t = new Date(`${d.slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(t.getTime()) ? d : DAY_MONTH.format(t);
}
const WHOSE_LABEL: Record<Exclude<Whose, "">, string> = { own: "Mine", team: "My team", other: "Others" };

export function MyDealersView() {
    const [bucket, setBucket] = useState<AccountBucket | "">("");
    const [whose, setWhose] = useState<Whose>("");
    // ID 241-3: the "Not visited in 30 days" chip as a filter.
    const [notVisitedOnly, setNotVisitedOnly] = useState(false);
    const { data, isLoading, error } = useQuery<{
        rows: MyDealerRow[];
        scope: "own" | "team" | "all";
        can_record_orders: boolean;
    }>({
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

    const allRows = data?.rows ?? [];
    const rows = [...(whose ? allRows.filter((r) => r.scope === whose) : allRows)].sort(
        (a, b) =>
            URGENCY.indexOf(a.bucket) - URGENCY.indexOf(b.bucket) ||
            (b.days_since_last_order ?? 0) - (a.days_since_last_order ?? 0),
    );
    const counts = Object.fromEntries(ACCOUNT_BUCKETS.map((b) => [b, rows.filter((r) => r.bucket === b).length])) as Record<
        AccountBucket,
        number
    >;
    const notVisitedCount = rows.filter((r) => r.not_visited_30).length;
    const visible = (bucket ? rows.filter((r) => r.bucket === bucket) : rows).filter((r) => !notVisitedOnly || r.not_visited_30);

    if (allRows.length === 0) {
        return (
            <p className="rounded-xl border border-border bg-surface px-4 py-8 text-center text-sm text-ink-muted">
                No dealers assigned to you yet.{" "}
                <InfoTip>Your Sales Head assigns dealer owners on the Accounts page.</InfoTip>
            </p>
        );
    }

    return (
        <div className="space-y-5">
            {data?.scope && data.scope !== "own" && (
                <div className="flex flex-wrap gap-2">
                    {(["", "own", data.scope === "team" ? "team" : "other"] as Whose[]).map((w) => (
                        <button
                            key={w || "all"}
                            type="button"
                            onClick={() => setWhose(w)}
                            className={`rounded-lg border px-3 py-1 text-xs font-semibold ${whose === w ? "bg-brand-navy text-white border-brand-navy" : "border-border text-ink"}`}
                        >
                            {w ? WHOSE_LABEL[w] : "All"} · {w ? allRows.filter((r) => r.scope === w).length : allRows.length}
                        </button>
                    ))}
                </div>
            )}
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
                {/* ID 241-3: managers see it for their team through the same scope. */}
                <button
                    type="button"
                    onClick={() => setNotVisitedOnly((v) => !v)}
                    aria-pressed={notVisitedOnly}
                    className={`rounded-full border border-dashed px-3 py-1 text-xs font-medium text-ink ${notVisitedOnly ? "ring-2 ring-offset-1 ring-ink/40 bg-bg" : "border-border"}`}
                >
                    Not visited in 30 days · {notVisitedCount}
                </button>
            </div>

            <div className="rounded-xl border border-border bg-surface shadow-card overflow-x-auto">
                <table className="w-full min-w-[900px] text-sm">
                    <thead className="bg-bg/60 text-[11px] uppercase tracking-wide text-ink-muted">
                        <tr>
                            <th className="px-3 py-2 text-left font-semibold">Dealer</th>
                            <th className="px-3 py-2 text-left font-semibold">Reorder stage</th>
                            <th className="px-3 py-2 text-left font-semibold">Last invoice</th>
                            <th className="px-3 py-2 text-right font-semibold">Days since</th>
                            <th className="px-3 py-2 text-right font-semibold">Usual gap (days)</th>
                            <th className="px-3 py-2 text-right font-semibold">Revenue, last 90 days</th>
                            <th className="px-3 py-2 text-right font-semibold">Lifetime</th>
                            <th className="px-3 py-2 text-left font-semibold">Last visit</th>
                            <th className="px-3 py-2" />
                            {data?.can_record_orders && <th className="px-3 py-2" />}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {visible.map((r) => (
                            <tr key={r.key}>
                                <td className="px-3 py-2">
                                    {r.account_id ? (
                                        <Link
                                            href={`/my-dealers/${encodeURIComponent(r.account_id)}`}
                                            className="font-medium text-brand-sky hover:underline"
                                        >
                                            {r.dealer}
                                        </Link>
                                    ) : (
                                        <span className="font-medium text-ink">{r.dealer}</span>
                                    )}
                                    <div className="text-[11px] text-ink-muted">
                                        {[
                                            r.city,
                                            r.gstin_missing ? "GSTIN missing" : r.gstin,
                                            r.scope !== "own" ? `Owner: ${r.owner_name ?? "none"}` : null,
                                        ]
                                            .filter(Boolean)
                                            .join(" · ")}
                                    </div>
                                </td>
                                <td className="px-3 py-2">
                                    <span className={`rounded-full border px-2 py-0.5 text-[11px] ${BUCKET_TONE[r.bucket]}`}>
                                        {ACCOUNT_BUCKET_LABELS[r.bucket].split(" (")[0]}
                                    </span>
                                    {r.closed_reason && <div className="mt-1 text-[11px] text-ink-muted">{r.closed_reason}</div>}
                                    {r.order_claim && <OrderClaimBadge claim={r.order_claim} />}
                                    {r.not_visited_30 && (
                                        <span className="ml-1 inline-block rounded-full border border-dashed border-rose-300 px-2 py-0.5 text-[11px] text-rose-700">
                                            Not visited in 30 days
                                        </span>
                                    )}
                                </td>
                                <td className="px-3 py-2 text-ink-muted">{r.last_order ?? "—"}</td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                    {r.days_since_last_order ?? r.days_since_conversion ?? "—"}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">{r.avg_reorder_days ?? "—"}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{inr(r.revenue_90d)}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{inr(r.revenue_lifetime)}</td>
                                <td className={`px-3 py-2 whitespace-nowrap ${r.not_visited_30 ? "text-rose-700" : "text-ink-muted"}`}>
                                    {r.last_visit_date ? lastVisitLabel(r.last_visit_date) : "None yet"}
                                </td>
                                <td className="px-3 py-2 text-right">
                                    {/* ID 210: straight to the camera + location page for this counter. */}
                                    {r.account_id && r.can_log_visit && (
                                        <Link
                                            href={`/visits/capture?account=${encodeURIComponent(r.account_id)}`}
                                            className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-border px-2 py-1 text-xs font-medium text-brand-sky hover:bg-bg"
                                        >
                                            <MapPin className="h-3.5 w-3.5" />
                                            Log visit
                                        </Link>
                                    )}
                                </td>
                                {data?.can_record_orders && (
                                    <td className="px-3 py-2 text-right">
                                        {r.account_id && r.scope === "own" && r.bucket !== "closed" && !r.order_claim && (
                                            <OrderPlacedButton accountId={r.account_id} />
                                        )}
                                    </td>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {data?.can_record_orders && <OrderClaimsList canWithdraw mine title="My orders placed, no invoice yet" />}
        </div>
    );
}
