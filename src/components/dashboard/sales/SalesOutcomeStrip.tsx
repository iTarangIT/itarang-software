"use client";

// Review R-10 — what the effort in this range produced. The KPI row above says
// how busy the team was; this row says what came of it, so a busy rep and a
// productive rep no longer look identical.

import type { SalesDashboard } from "@/lib/admin/salesDashboardTypes";
import { batteryReading } from "@/lib/admin/batteryReading";

const fmt = (n: number) => n.toLocaleString("en-IN");
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

export function SalesOutcomeStrip({ d }: { d: SalesDashboard }) {
    // An invoice with no item lines adds 0 batteries whatever it sold, so the
    // tile says how much of the count is known instead of showing a bare 0.
    const bat = batteryReading(d.outcome);
    const plural = (n: number | null) => `${fmt(n ?? 0)} invoice${n === 1 ? "" : "s"}`;
    const batteryHint =
        bat.state === "unknown"
            ? `unknown — no item lines on the ${plural(bat.invoices)} in range`
            : bat.state === "partial"
              ? `at least — item lines on ${fmt(bat.with_lines ?? 0)} of ${plural(bat.invoices)}`
              : "HSN 8507 lines on linked invoices";
    const tiles = [
        {
            label: "Quotes issued",
            value: fmt(d.outcome.quotes_issued),
            hint: `first quote per lead · ${fmt(d.outcome.quote_revisions ?? 0)} revisions`,
        },
        { label: "Converted", value: fmt(d.totals.converted), hint: "leads closed as Converted" },
        {
            label: "Batteries to dealers",
            value: bat.value == null ? "—" : `${fmt(bat.value)}${bat.state === "partial" ? "+" : ""}`,
            hint: batteryHint,
        },
        { label: "Revenue", value: inr(d.outcome.revenue), hint: "invoices linked on GSTIN" },
        { label: "KYC submitted", value: fmt(d.outcome.kyc_submitted), hint: "files from linked dealers" },
    ];
    return (
        <div className="rounded-xl border border-border bg-surface shadow-card">
            <div className="px-4 pt-3">
                <h3 className="text-sm font-semibold text-ink">Outcome</h3>
                <p className="text-[11px] text-ink-muted">
                    What this range produced. Revenue, batteries and KYC count invoices matched to a
                    dealer on GSTIN and are credited to that dealer account&apos;s owner on the invoice
                    date — a dealer with no owner shows under Unassigned in Per SPOC. Invoices that
                    match no dealer are not counted here; they are listed on Sales Invoices.
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
