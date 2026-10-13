"use client";

// ID 86 — how fast leads and new owners were first attempted and contacted,
// for clocks started in the screen's period (/api/admin/reports/lead-clocks,
// lead_clocks rebuilt hourly). Median and the slowest 1 in 10, in working
// hours; the share attempted within the limit set in Admin › Time limits.

import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/components/auth/AuthProvider";
import type { ClockStats } from "@/lib/leads/clocks";
import { CardLink, DashCard, LoadingBlock, NotAvailable, num } from "@/components/dashboard/redesign/primitives";

type Payload = {
    available: boolean;
    computed_at: string | null;
    lead: ClockStats | null;
    owner: ClockStats | null;
    transfer: ClockStats | null;
    limits_passed: number | null;
};

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
    const qs = new URLSearchParams({ from, to });
    if (spocId) qs.set("spoc_id", spocId);
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
                    Clocks started in the period · working hours (Mon–Sat 10:00–19:00, holidays off)
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
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    {!spocId && <Clock title="Leads" s={d.lead} note="From sales-ready, anyone's call or visit." />}
                    <Clock title="New owners" s={d.owner} note="From each assignment, that owner's call or visit." />
                    <Clock title="Field visit after transfer" s={d.transfer} note="From Transfer to ASM to a visit marked visited." />
                </div>
            )}
        </DashCard>
    );
}
