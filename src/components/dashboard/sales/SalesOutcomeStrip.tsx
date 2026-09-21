"use client";

// Review R-10 — what the effort in this range produced. The KPI row above says
// how busy the team was; this row says what came of it, so a busy rep and a
// productive rep no longer look identical.

import type { SalesDashboard } from "@/lib/admin/salesDashboardTypes";

const fmt = (n: number) => n.toLocaleString("en-IN");
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

export function SalesOutcomeStrip({ d }: { d: SalesDashboard }) {
    const tiles = [
        { label: "Quotes issued", value: fmt(d.outcome.quotes_issued), hint: "quote versions created" },
        { label: "Converted", value: fmt(d.totals.converted), hint: "leads closed as Converted" },
        {
            label: "Batteries to dealers",
            value: fmt(d.outcome.batteries_to_dealers),
            hint: "allocated to a linked dealer",
        },
        { label: "Revenue", value: inr(d.outcome.revenue), hint: "invoices linked on GSTIN" },
        { label: "KYC submitted", value: fmt(d.outcome.kyc_submitted), hint: "files from linked dealers" },
    ];
    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="px-4 pt-3">
                <h3 className="text-sm font-semibold text-ink">Outcome</h3>
                <p className="text-[11px] text-ink-muted">
                    What this range produced. Revenue, batteries and KYC reach a person through
                    the dealer&apos;s GSTIN on their converted lead — a dealer with no GSTIN in the CRM
                    counts for no one. Unlinked invoices are listed on Sales Invoices.
                </p>
            </div>
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-b-xl bg-border sm:grid-cols-3 lg:grid-cols-5 mt-3">
                {tiles.map((t) => (
                    <div key={t.label} className="bg-surface px-4 py-3">
                        <p className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">{t.label}</p>
                        <p className="mt-1 text-xl font-semibold tabular-nums text-ink">{t.value}</p>
                        <p className="text-[11px] text-ink-muted">{t.hint}</p>
                    </div>
                ))}
            </div>
        </div>
    );
}
