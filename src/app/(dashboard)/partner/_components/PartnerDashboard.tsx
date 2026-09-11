"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
    ArrowRight,
    Bell,
    CalendarClock,
    CheckCircle2,
    FileText,
    Inbox,
    ListChecks,
    Receipt,
    Send,
    Users,
} from "lucide-react";
import { KPICard } from "@/components/shared/kpi-card";
import { useBuybackNotificationSummary } from "@/hooks/useBuybackNotificationSummary";
import type { QueueCounts } from "@/lib/inside-sales/types";
import {
    fetchPartnerQuotations,
    QUOTATIONS_QUERY_KEY,
    StatusPill,
    type PartnerQuotation,
} from "../quotations/_components/PartnerQuotationsView";

const inr = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
});

async function fetchQueueCounts(): Promise<QueueCounts> {
    const res = await fetch("/api/inside-sales/queue/counts", { cache: "no-store" });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) throw new Error(json?.error?.message ?? "Failed to load queue counts");
    return json.data as QueueCounts;
}

function QuoteRow({ q }: { q: PartnerQuotation }) {
    return (
        <li className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0">
                <Link
                    href={`/partner/lead/${encodeURIComponent(q.dealer_lead_id)}`}
                    className="block truncate text-sm font-medium text-blue-700 hover:underline"
                >
                    {q.dealer_name || q.shop_name || "(unnamed dealer)"}
                </Link>
                <div className="text-xs text-gray-500">
                    {q.quote_number ? <span className="font-mono">{q.quote_number} · </span> : null}
                    {inr.format(q.value)}
                    {q.city ? ` · ${q.city}` : ""}
                </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
                <StatusPill q={q} />
                {q.quote_pdf_url && (
                    <a
                        href={q.quote_pdf_url}
                        target="_blank"
                        rel="noreferrer"
                        title="Open proforma PDF"
                        className="rounded-md border border-gray-300 p-1 text-gray-600 hover:bg-gray-50"
                    >
                        <FileText className="h-3.5 w-3.5" />
                    </a>
                )}
            </div>
        </li>
    );
}

export function PartnerDashboard() {
    // Same key shape as the queue page's unfiltered count so the two dedupe.
    const counts = useQuery({ queryKey: ["inside-sales-counts", ""], queryFn: fetchQueueCounts });
    const quotes = useQuery({
        queryKey: [QUOTATIONS_QUERY_KEY, "all"],
        queryFn: () => fetchPartnerQuotations("all"),
        refetchInterval: 30_000,
    });
    const buyback = useBuybackNotificationSummary(true);

    const pending = (quotes.data?.quotations ?? []).filter((q) => q.approval_status === "pending").slice(0, 5);
    const approved = (quotes.data?.quotations ?? []).filter((q) => q.approval_status === "approved").slice(0, 5);
    const c = counts.data;

    return (
        <div className="space-y-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                <KPICard title="My Open Leads" value={c?.my_open ?? "…"} icon={Users} />
                <KPICard title="Follow-ups Today" value={c?.follow_ups ?? "…"} icon={CalendarClock} />
                <KPICard title="Unassigned (Claim)" value={c?.unassigned ?? "…"} icon={Inbox} />
                <KPICard title="PIs Pending with CEO" value={quotes.data?.counts.pending ?? "…"} icon={Receipt} />
                <KPICard title="Approved PIs" value={quotes.data?.counts.approved ?? "…"} icon={CheckCircle2} />
                <KPICard title="Buyback Unread" value={buyback.unread.total} icon={Bell} />
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <section className="rounded-lg border border-gray-200 bg-white p-4">
                    <div className="mb-2 flex items-center justify-between">
                        <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                            <Receipt className="h-4 w-4 text-amber-600" />
                            Pending with CEO
                        </h2>
                        <Link href="/partner/quotations" className="text-xs text-blue-700 hover:underline">
                            All quotations
                        </Link>
                    </div>
                    {quotes.error && (
                        <p className="text-sm text-rose-700">{(quotes.error as Error).message}</p>
                    )}
                    {pending.length === 0 ? (
                        <p className="py-3 text-sm text-gray-500">Nothing waiting on the CEO.</p>
                    ) : (
                        <ul className="divide-y divide-gray-100">
                            {pending.map((q) => (
                                <QuoteRow key={q.commercial_id} q={q} />
                            ))}
                        </ul>
                    )}
                </section>

                <section className="rounded-lg border border-gray-200 bg-white p-4">
                    <div className="mb-2 flex items-center justify-between">
                        <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                            <Send className="h-4 w-4 text-emerald-600" />
                            Recently approved
                        </h2>
                        <Link href="/partner/quotations" className="text-xs text-blue-700 hover:underline">
                            All quotations
                        </Link>
                    </div>
                    {approved.length === 0 ? (
                        <p className="py-3 text-sm text-gray-500">No approved quotations yet.</p>
                    ) : (
                        <ul className="divide-y divide-gray-100">
                            {approved.map((q) => (
                                <QuoteRow key={q.commercial_id} q={q} />
                            ))}
                        </ul>
                    )}
                </section>
            </div>

            <section className="rounded-lg border border-gray-200 bg-white p-4">
                <div className="mb-2 flex items-center justify-between">
                    <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                        <Bell className="h-4 w-4 text-[#0B2239]" />
                        Battery Buyback — needs attention
                    </h2>
                    <Link href="/admin/buyback/dashboard" className="text-xs text-blue-700 hover:underline">
                        Buyback dashboard
                    </Link>
                </div>
                {buyback.actions.length === 0 ? (
                    <p className="py-3 text-sm text-gray-500">No buyback requests waiting on you.</p>
                ) : (
                    <div className="flex flex-wrap gap-2">
                        {buyback.actions.map((a) => (
                            <Link
                                key={a.href + a.label}
                                href={a.href}
                                className="inline-flex items-center gap-2 rounded-full border border-gray-300 bg-gray-50 px-3 py-1 text-xs font-medium text-gray-800 hover:bg-gray-100"
                            >
                                {a.label}
                                <span className="rounded-full bg-[#0B2239] px-1.5 py-0.5 text-[10px] text-white tabular-nums">
                                    {a.count}
                                </span>
                            </Link>
                        ))}
                    </div>
                )}
            </section>

            <div className="flex flex-wrap gap-2">
                <Link
                    href="/partner/leads?tab=unassigned"
                    className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                >
                    <ListChecks className="h-4 w-4" />
                    Claim unassigned leads
                    <ArrowRight className="h-3.5 w-3.5" />
                </Link>
                <Link
                    href="/leads/new"
                    className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                >
                    New lead
                    <ArrowRight className="h-3.5 w-3.5" />
                </Link>
                <Link
                    href="/leads/neodove-campaigns"
                    className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                >
                    NeoDove campaigns
                    <ArrowRight className="h-3.5 w-3.5" />
                </Link>
                <Link
                    href="/admin/buyback"
                    className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                >
                    Buyback requests
                    <ArrowRight className="h-3.5 w-3.5" />
                </Link>
            </div>
        </div>
    );
}
