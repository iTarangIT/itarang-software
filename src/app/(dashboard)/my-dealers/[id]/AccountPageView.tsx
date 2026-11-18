"use client";

// E-358 — the account page in My Dealers: who the account is, and its account
// quotations (create / send / track). A 403 from the API is shown as such:
// an account you are not assigned to is not yours to quote.
//
// ID 241-1 (mock-up "Dealer page", 13 Nov pack): the header carries the stage,
// last invoice, usual gap, revenue and last visit (My dealers' own numbers); a
// Next step box says what to do, from facts only; and ONE history list shows
// visits, quotes, recorded orders and invoices, newest first. Quotes, Record
// order and Log visit work as before.

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Camera, CheckCircle2, FileText, IndianRupee, Loader2, MapPin, Plus, ShoppingCart } from "lucide-react";

import { AccountQuotationsPanel } from "@/components/accounts/AccountQuotations";
import { OrderPlacedButton } from "@/components/accounts/OrderClaims";
import type { AccountSummary } from "@/lib/accounts/quotations/access";
import type { AccountBucket } from "@/lib/dealers/accountHealthRules";
import {
    HISTORY_FILTERS,
    bucketChip,
    dealerNextStep,
    historyMatches,
    type HistoryFilter,
    type HistoryItem,
    type NextStepTone,
} from "@/lib/visits/dealerVisitOutcomes";

type HistoryData = {
    today: string;
    health: {
        bucket: AccountBucket;
        dealer: string;
        city: string | null;
        lead_id: string | null;
        lead_href: string | null;
        came_through: string | null;
        converted_on: string | null;
        last_order: string | null;
        days_since_last_order: number | null;
        days_since_conversion: number | null;
        orders: number;
        revenue_90d: number;
        revenue_lifetime: number;
        avg_reorder_days: number | null;
        pending_order: boolean;
        owner_id: string | null;
        owner_name: string | null;
    } | null;
    last_invoice_title: string | null;
    last_visit_at: string | null;
    next_visit: { visit_id: string; scheduled_date: string | null; asm_name: string | null } | null;
    can_log_visit: boolean;
    can_record_order: boolean;
    owner_is_you: boolean;
    history: HistoryItem[];
};

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

const STEP_TONE: Record<NextStepTone, { box: string; label: string }> = {
    red: { box: "border-rose-200 bg-rose-50", label: "text-rose-700" },
    orange: { box: "border-orange-200 bg-orange-50", label: "text-orange-700" },
    amber: { box: "border-amber-200 bg-amber-50", label: "text-amber-800" },
    sky: { box: "border-sky-200 bg-sky-50", label: "text-sky-700" },
    green: { box: "border-emerald-200 bg-emerald-50", label: "text-emerald-700" },
    grey: { box: "border-slate-200 bg-slate-50", label: "text-slate-600" },
};

const FILTER_LABEL: Record<HistoryFilter, string> = { all: "All", visits: "Visits", quotes: "Quotes", invoices: "Invoices" };

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

function dayLabel(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }): string {
    if (!iso) return "—";
    const d = iso.length <= 10 ? new Date(`${iso}T00:00:00+05:30`) : new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-IN", { ...opts, timeZone: "Asia/Kolkata" });
}

function daysBetween(fromIso: string, todayIst: string): number {
    const from = fromIso.slice(0, 10);
    return Math.round((Date.parse(`${todayIst}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function AccountPageView({ accountId }: { accountId: string }) {
    const { data, isLoading, error } = useQuery<{ account: AccountSummary; can_create: boolean }>({
        queryKey: ["dealer-account", accountId],
        queryFn: async () => {
            const res = await fetch(`/api/dealer-accounts/${encodeURIComponent(accountId)}`, { cache: "no-store" });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? "Could not load this account");
            return json.data;
        },
        retry: false,
    });
    // ID 241-1: header numbers, next visit and the one history (fail-soft: the page works without it).
    const hist = useQuery<HistoryData>({
        queryKey: ["dealer-account-history", accountId],
        queryFn: async () => {
            const res = await fetch(`/api/dealer-accounts/${encodeURIComponent(accountId)}/history`, { cache: "no-store" });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message ?? "Could not load the history");
            return json.data;
        },
        enabled: !!data,
        retry: false,
    });
    const h = hist.data;
    const logVisitHref = `/visits/capture?account=${encodeURIComponent(accountId)}`;
    const canLogVisit = h ? h.can_log_visit : !!data?.can_create;

    return (
        <>
            <Link href="/my-dealers" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-sky hover:underline">
                <ArrowLeft className="h-3.5 w-3.5" /> Back to My dealers
            </Link>
            {isLoading && (
                <div className="flex items-center gap-2 text-sm text-ink-muted">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
            )}
            {error && (
                <p className="rounded-xl border border-border bg-surface px-4 py-8 text-center text-sm text-rose-600">
                    {(error as Error).message}
                </p>
            )}
            {data && (
                <>
                    <header className="rounded-xl border border-border bg-surface px-4 py-4 shadow-card">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h1 className="text-xl font-semibold tracking-tight text-ink">{data.account.name}</h1>
                                    {h?.health && (
                                        <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${BUCKET_TONE[h.health.bucket]}`}>
                                            {bucketChip(h.health.bucket)}
                                        </span>
                                    )}
                                </div>
                                <p className="mt-0.5 text-sm text-ink-muted">
                                    {[
                                        data.account.city,
                                        h?.health?.converted_on ? `dealer since ${dayLabel(h.health.converted_on)}` : null,
                                    ]
                                        .filter(Boolean)
                                        .join(" · ")}
                                    {h?.health?.lead_href && (
                                        <>
                                            {" · from a lead ("}
                                            <Link href={h.health.lead_href} className="text-brand-sky hover:underline">
                                                open the lead&apos;s history
                                            </Link>
                                            {")"}
                                        </>
                                    )}
                                </p>
                            </div>
                            <div className="text-right">
                                <div className="text-[11px] uppercase tracking-wide text-ink-muted">Owner</div>
                                <div className="text-sm font-semibold text-ink">
                                    {data.account.owner_name ?? "No owner"}
                                    {h?.owner_is_you ? " (you)" : ""}
                                </div>
                            </div>
                        </div>
                        {h?.health && <HeaderStats h={h} />}
                    </header>

                    {h?.health && (
                        <NextStepBox
                            h={h}
                            accountId={accountId}
                            logVisitHref={canLogVisit ? logVisitHref : null}
                            canQuote={data.can_create}
                        />
                    )}
                    {!h?.health && canLogVisit && (
                        <div className="flex justify-end">
                            <Link
                                href={logVisitHref}
                                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-ink hover:bg-gray-50"
                            >
                                <Camera className="h-4 w-4" /> Log visit
                            </Link>
                        </div>
                    )}

                    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                        <HistoryCard h={h} loading={hist.isLoading} failed={hist.isError} />
                        <div className="space-y-5">
                            <div id="quotes">
                                <AccountQuotationsPanel accountId={accountId} />
                            </div>
                            <DetailsCard account={data.account} />
                        </div>
                    </div>
                </>
            )}
        </>
    );
}

function HeaderStats({ h }: { h: HistoryData }) {
    const s = h.health!;
    const lastVisitDays = h.last_visit_at ? daysBetween(h.last_visit_at, h.today) : null;
    return (
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-border pt-3 text-sm lg:grid-cols-4">
            <div>
                <dt className="text-xs text-ink-muted">Last invoice</dt>
                <dd className="font-semibold text-ink">
                    {s.last_order ? `${dayLabel(s.last_order)}${h.last_invoice_title ? ` · ${h.last_invoice_title.split(" · ")[1] ?? ""}` : ""}` : "None yet"}
                </dd>
                {s.days_since_last_order != null && (
                    <dd className={`text-xs ${s.days_since_last_order > 30 ? "text-rose-600" : "text-ink-muted"}`}>
                        {s.days_since_last_order} days ago
                    </dd>
                )}
            </div>
            <div>
                <dt className="text-xs text-ink-muted">Usual gap</dt>
                <dd className="font-semibold text-ink">{s.avg_reorder_days != null ? `~${Math.round(s.avg_reorder_days)} days` : "Not known yet"}</dd>
                <dd className="text-xs text-ink-muted">
                    {s.orders === 0 ? "No invoice yet" : s.orders === 1 ? "Only one invoice so far" : `${s.orders} invoices`}
                </dd>
            </div>
            <div>
                <dt className="text-xs text-ink-muted">Revenue</dt>
                <dd className="font-semibold text-ink">{inr(s.revenue_90d)} in 90 days</dd>
                <dd className="text-xs text-ink-muted">{inr(s.revenue_lifetime)} lifetime</dd>
            </div>
            <div>
                <dt className="text-xs text-ink-muted">Last visit</dt>
                <dd className={`font-semibold ${lastVisitDays == null || lastVisitDays > 30 ? "text-rose-600" : "text-ink"}`}>
                    {h.last_visit_at ? `${dayLabel(h.last_visit_at)}${lastVisitDays != null && lastVisitDays > 30 ? " · 30+ days" : ""}` : "None yet"}
                </dd>
                <dd className="text-xs text-ink-muted">
                    Next visit: {h.next_visit?.scheduled_date ? dayLabel(h.next_visit.scheduled_date, { weekday: "short", day: "numeric", month: "short" }) : "not booked"}
                </dd>
            </div>
        </dl>
    );
}

function NextStepBox({
    h,
    accountId,
    logVisitHref,
    canQuote,
}: {
    h: HistoryData;
    accountId: string;
    logVisitHref: string | null;
    canQuote: boolean;
}) {
    const s = h.health!;
    const step = dealerNextStep(
        {
            bucket: s.bucket,
            daysSinceLastOrder: s.days_since_last_order,
            daysSinceConversion: s.days_since_conversion,
            orders: s.orders,
            nextVisitDate: h.next_visit?.scheduled_date ?? null,
            pendingOrder: s.pending_order,
        },
        h.today,
    );
    const tone = STEP_TONE[step.tone];
    return (
        <section className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-4 ${tone.box}`}>
            <div className="min-w-0">
                <div className={`text-[11px] font-semibold uppercase tracking-wider ${tone.label}`}>Next step</div>
                <div className="text-base font-semibold text-ink">{step.title}</div>
                <div className="text-sm text-ink-muted">{step.detail}</div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                {logVisitHref && (
                    <Link
                        href={logVisitHref}
                        className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
                    >
                        <Camera className="h-4 w-4" /> Log visit
                    </Link>
                )}
                {canQuote && (
                    <a
                        href="#quotes"
                        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-white px-3 py-2 text-sm font-medium text-ink hover:bg-gray-50"
                    >
                        <FileText className="h-4 w-4" /> Create quote
                    </a>
                )}
                {h.can_record_order && (
                    <div className="rounded-md border border-border bg-white px-3 py-2">
                        <OrderPlacedButton accountId={accountId} />
                    </div>
                )}
            </div>
        </section>
    );
}

const KIND_ICON: Record<HistoryItem["kind"], { icon: React.ReactNode; tone: string }> = {
    visit: { icon: <MapPin className="h-4 w-4" />, tone: "bg-emerald-50 text-emerald-700" },
    booked: { icon: <MapPin className="h-4 w-4" />, tone: "bg-sky-50 text-sky-700" },
    quote: { icon: <FileText className="h-4 w-4" />, tone: "bg-indigo-50 text-indigo-700" },
    order: { icon: <ShoppingCart className="h-4 w-4" />, tone: "bg-amber-50 text-amber-800" },
    invoice: { icon: <IndianRupee className="h-4 w-4" />, tone: "bg-emerald-50 text-emerald-700" },
    joined: { icon: <Plus className="h-4 w-4" />, tone: "bg-slate-100 text-slate-600" },
};

function HistoryCard({ h, loading, failed }: { h: HistoryData | undefined; loading: boolean; failed: boolean }) {
    const [filter, setFilter] = useState<HistoryFilter>("all");
    const items = useMemo(() => (h?.history ?? []).filter((i) => historyMatches(i, filter)), [h, filter]);
    const noVisit = !!h && !h.history.some((i) => i.kind === "visit");
    return (
        <section className="rounded-xl border border-border bg-surface px-4 py-4 shadow-card">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                    <h2 className="text-base font-semibold text-ink">History</h2>
                    <p className="text-xs text-ink-muted">Visits, quotes, orders and invoices in one list · newest first</p>
                </div>
                <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Show in history">
                    {HISTORY_FILTERS.map((f) => (
                        <button
                            key={f}
                            type="button"
                            role="tab"
                            aria-selected={filter === f}
                            onClick={() => setFilter(f)}
                            className={`rounded-full border px-3 py-1 text-xs font-medium ${
                                filter === f ? "border-ink bg-ink text-white" : "border-border text-ink hover:bg-gray-50"
                            }`}
                        >
                            {FILTER_LABEL[f]}
                        </button>
                    ))}
                </div>
            </div>
            {loading && (
                <div className="mt-4 flex items-center gap-2 text-sm text-ink-muted">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading history…
                </div>
            )}
            {failed && <p className="mt-4 text-sm text-rose-600">Could not load the history. Refresh to try again.</p>}
            {noVisit && (filter === "all" || filter === "visits") && (
                <p className="mt-3 rounded-lg border border-dashed border-rose-200 bg-rose-50/60 px-3 py-2 text-sm text-rose-700">
                    No visit logged since this dealer joined.
                </p>
            )}
            {h && items.length === 0 && !noVisit && <p className="mt-4 text-sm text-ink-muted">Nothing here yet.</p>}
            <ol className="mt-3 space-y-2.5">
                {items.map((it, i) => (
                    <li key={`${it.kind}-${it.at}-${i}`} className="flex gap-3">
                        <span className={`mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${KIND_ICON[it.kind].tone}`}>
                            {KIND_ICON[it.kind].icon}
                        </span>
                        <div className="min-w-0 flex-1 rounded-lg border border-border px-3 py-2">
                            <div className="flex flex-wrap items-baseline justify-between gap-2">
                                <div className="font-semibold text-ink">
                                    {it.title}
                                    {it.verified && (
                                        <span className="ml-2 inline-flex items-center gap-0.5 text-xs font-medium text-emerald-700">
                                            <CheckCircle2 className="h-3.5 w-3.5" /> Verified
                                        </span>
                                    )}
                                </div>
                                <div className="text-xs text-ink-muted">
                                    {dayLabel(it.at, { weekday: "short", day: "numeric", month: "short" })}
                                    {it.kind === "booked" && " · booked"}
                                </div>
                            </div>
                            {it.reportedAmount != null && (
                                <div className="text-sm text-ink">
                                    {inr(it.reportedAmount)} <span className="text-xs text-ink-muted">reported by the rep · not revenue</span>
                                </div>
                            )}
                            {it.detail && <p className="mt-0.5 whitespace-pre-line text-sm text-ink-muted">{it.detail}</p>}
                            <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-ink-muted">
                                {it.by && <span>By {it.by}</span>}
                                {it.photo && (
                                    <a href={it.photo} target="_blank" rel="noreferrer" className="text-brand-sky hover:underline">
                                        Shop photo
                                    </a>
                                )}
                                {it.kind === "joined" && h?.health?.lead_href && (
                                    <Link href={h.health.lead_href} className="text-brand-sky hover:underline">
                                        Open the lead&apos;s history
                                    </Link>
                                )}
                            </div>
                        </div>
                    </li>
                ))}
            </ol>
        </section>
    );
}

function DetailsCard({ account }: { account: AccountSummary }) {
    const location = [account.city, account.state].filter(Boolean).join(", ");
    const contact = [account.contact_name, account.contact_phone].filter(Boolean).join(" · ");
    const missing = <span className="font-medium text-orange-700">Missing · add at next visit</span>;
    return (
        <section className="rounded-xl border border-border bg-surface px-4 py-4 shadow-card">
            <h2 className="text-base font-semibold text-ink">Details</h2>
            <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                <div>
                    <dt className="text-xs text-ink-muted">GSTIN</dt>
                    <dd className="text-ink">{account.gstin || missing}</dd>
                </div>
                <div>
                    <dt className="text-xs text-ink-muted">Contact</dt>
                    <dd className="text-ink">{contact || missing}</dd>
                </div>
                <div>
                    <dt className="text-xs text-ink-muted">Email</dt>
                    <dd className="break-all text-ink">{account.contact_email || "—"}</dd>
                </div>
                <div>
                    <dt className="text-xs text-ink-muted">Location</dt>
                    <dd className="text-ink">{location || missing}</dd>
                </div>
            </dl>
        </section>
    );
}
