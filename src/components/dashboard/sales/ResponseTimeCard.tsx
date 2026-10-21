"use client";

// ID 86 — how fast leads and new owners were first attempted and contacted,
// for clocks started in the screen's period (/api/admin/reports/lead-clocks,
// lead_clocks rebuilt hourly). Median and the slowest 1 in 10, in working
// hours; the share attempted within the limit set in Admin › Time limits.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/components/auth/AuthProvider";
import type { ClockStats, OwnerClockRow } from "@/lib/leads/clocks";
import { CardLink, DashCard, LoadingBlock, NotAvailable, num } from "@/components/dashboard/redesign/primitives";

type Payload = {
    available: boolean;
    computed_at: string | null;
    lead: ClockStats | null;
    owner: ClockStats | null;
    transfer: ClockStats | null;
    limits_passed: number | null;
    /** 18 Oct row 28 — one row per owner, owner clock. */
    by_owner?: OwnerClockRow[];
    include_guessed?: boolean;
    /** "Mon–Sat 10:00–19:00" from Admin › Time limits › Office hours. */
    office_hours?: string;
};

const MANAGER_ROLES = new Set(["admin", "ceo", "sales_head", "business_head"]);

/** One row per owner: median, slowest 1 in 10, % within the limit, limits passed. */
function OwnerTable({ rows }: { rows: OwnerClockRow[] }) {
    if (!rows.length) return <p className="text-[12.5px] text-ink-muted">No owner clocks started in the period.</p>;
    return (
        <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
                <thead className="text-left text-[11px] uppercase tracking-wide text-ink-muted">
                    <tr>
                        <th className="px-2 py-1.5 font-semibold">Owner</th>
                        <th className="px-2 py-1.5 text-right font-semibold">Clocks</th>
                        <th className="px-2 py-1.5 text-right font-semibold">First attempt: median</th>
                        <th className="px-2 py-1.5 text-right font-semibold">Slowest 1 in 10</th>
                        <th className="px-2 py-1.5 text-right font-semibold">Within limit</th>
                        <th className="px-2 py-1.5 text-right font-semibold">Limits passed</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border">
                    {rows.map((r) => (
                        <tr key={r.owner_id}>
                            <td className="px-2 py-1.5">{r.owner_name ?? r.owner_id}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{num(r.started)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{h(r.attempt_median_h)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{h(r.attempt_p90_h)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">
                                {r.pct_in_limit == null ? "—" : `${r.pct_in_limit}% (${num(r.in_limit)} of ${num(r.due)})`}
                            </td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{num(r.limits_passed)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

const h = (v: number | null | undefined) => (v == null ? "—" : `${v.toFixed(1)} h`);

function Clock({ title, s, note }: { title: string; s: ClockStats | null; note: string }) {
    return (
        <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-[#fbfcfd] p-4">
            <span className="text-[13px] font-semibold">{title}</span>
            <span className="text-[26px] font-bold tabular-nums text-brand-navy">
                {s?.pct_in_limit == null ? "—" : `${s.pct_in_limit}%`}
            </span>
            <span className="text-[12.5px] text-ink-muted">
                within the limit · {s ? `${num(s.in_limit)} of ${num(s.due)}` : "—"}
            </span>
            <span className="text-[12.5px] text-ink-muted">
                First attempt: median {h(s?.attempt_median_h)}, slowest 1 in 10 {h(s?.attempt_p90_h)}
            </span>
            <span className="text-[12.5px] text-ink-muted">
                First contact: median {h(s?.contact_median_h)}, slowest 1 in 10 {h(s?.contact_p90_h)}
            </span>
            <span className="text-[12px] text-ink-muted">{note}</span>
        </div>
    );
}

export function ResponseTimeCard({ from, to, spocId }: { from: string; to: string; spocId?: string }) {
    // The Time limits page is admin and CEO only (decided 10 Oct); other roles
    // got an application error from the card's link.
    const { user } = useAuth();
    const canSeeLimits = user?.role === "admin" || user?.role === "ceo";
    // 18 Oct #7: a manager may count the misses before 10 Sep with a guessed owner.
    const isManager = MANAGER_ROLES.has(user?.role ?? "");
    const [includeGuessed, setIncludeGuessed] = useState(false);
    const qs = new URLSearchParams({ from, to });
    if (spocId) qs.set("spoc_id", spocId);
    if (includeGuessed && isManager) qs.set("include_guessed", "1");
    const q = useQuery<Payload>({
        queryKey: ["sales-head-ops", "lead-clocks", qs.toString()],
        queryFn: async () => {
            const res = await fetch(`/api/admin/reports/lead-clocks?${qs}`, { cache: "no-store" });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Failed to load");
            return json.data as Payload;
        },
        placeholderData: (prev) => prev,
        retry: false,
    });
    const d = q.data;

    return (
        <DashCard
            title="Response time"
            caption={
                <span className="text-[13px] text-ink-muted">
                    Clocks started in the period · working hours ({d?.office_hours ?? "office hours"}, holidays off)
                    {d?.limits_passed != null ? ` · ${num(d.limits_passed)} time limits passed` : ""}
                </span>
            }
            action={canSeeLimits ? <CardLink href="/admin/settings/time-limits">Time limits</CardLink> : undefined}
        >
            {q.isLoading ? (
                <LoadingBlock />
            ) : !d?.available ? (
                <NotAvailable reason="Lead clocks are not set up on this server yet (migration E-337)." />
            ) : (
                <div className="space-y-4">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        {!spocId && <Clock title="Leads" s={d.lead} note="From sales-ready, anyone's call or visit." />}
                        <Clock title="New owners" s={d.owner} note="From each assignment, that owner's call or visit." />
                        <Clock title="Field visit after transfer" s={d.transfer} note="From Transfer to ASM to a visit marked visited." />
                    </div>
                    <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-[13px] font-semibold">By owner · first call or visit after assignment</span>
                            {isManager && (
                                <label className="flex items-center gap-1.5 text-[12px] text-ink-muted">
                                    <input
                                        type="checkbox"
                                        checked={includeGuessed}
                                        onChange={(e) => setIncludeGuessed(e.target.checked)}
                                    />
                                    Include misses before 10 Sep with a guessed owner
                                </label>
                            )}
                        </div>
                        <OwnerTable rows={d.by_owner ?? []} />
                    </div>
                </div>
            )}
        </DashCard>
    );
}
