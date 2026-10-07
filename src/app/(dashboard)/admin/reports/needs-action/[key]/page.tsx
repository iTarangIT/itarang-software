// The list behind one Sales Head "Needs action now" tile — the same rows the
// tile counts (src/lib/dashboard/salesHeadActions.ts), with the dashboard's
// filters carried over in the URL. Each row opens the lead, where the actions
// (call, reassign, mark Won, …) live. The filter bar is a plain GET form, and
// "Download CSV" sends the same query string to the API, so the file holds
// exactly the rows on screen.

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download } from "lucide-react";

import { requireRole } from "@/lib/auth-utils";
import {
    ACTION_KEYS,
    ACTION_TITLES,
    listSalesHeadAction,
    listSalesHeadActionFiltered,
    type ActionKey,
} from "@/lib/dashboard/salesHeadActions";

export const dynamic = "force-dynamic";

const inr = (n: number) =>
    n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(2)} L` : `₹${Math.round(n).toLocaleString("en-IN")}`;

const RULE: Record<ActionKey, string> = {
    sales_ready: "Leads marked sales-ready that nobody owns yet. Assign them from Ready to Assign.",
    hot_not_called:
        "Hot leads with an owner and no call or visit since the owner got the lead, more than 4 working hours ago (Mon–Sat, 10:00–19:00 IST). Leads with an ASM for a visit, and dead / non-responsive numbers, are left out.",
    visit_overdue: "Leads transferred to an ASM whose first visit is past the admin-set limit, with no visit marked since the transfer.",
    quotes_no_answer:
        "The lead's latest quote was delivered to the dealer more than 3 working days ago and the dealer has neither approved nor declined it. Withdrawn quotes and closed leads are left out.",
    said_yes: "The dealer approved the quote, but the lead has not been marked Won.",
    onboarding_stalled:
        "Won leads whose onboarding has stopped: waiting on the dealer 7+ days, or waiting on us 2+ working days. Leads already in the 21-day drop-out review are listed there instead.",
    won_without_quote: "Leads marked Won this month with no quote the dealer approved. Check the price before onboarding.",
    hot_aged:
        "Open leads (not Converted or Lost) rated Hot for more than 7 days, counted from the day the lead became Hot. A Hot lead this old needs a decision: push it to a quote, transfer it for a visit, or re-rate it.",
};

export default async function NeedsActionListPage({
    params,
    searchParams,
}: {
    params: Promise<{ key: string }>;
    searchParams: Promise<Record<string, string | undefined>>;
}) {
    const user = await requireRole(["admin", "sales_head", "ceo", "partner", "business_head"]);
    const { key } = await params;
    if (!(ACTION_KEYS as readonly string[]).includes(key)) notFound();
    const k = key as ActionKey;

    const sp = await searchParams;
    const qs = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => typeof e[1] === "string"));
    qs.delete("format");
    // Filtered rows for the table; the unfiltered list feeds the dropdowns, so
    // picking a state never hides the other states from the menu.
    const [rows, all] = await Promise.all([listSalesHeadActionFiltered(k, qs), listSalesHeadAction(k, {})]);
    const states = [...new Set(all.map((r) => r.state?.trim()).filter((v): v is string => !!v))].sort();
    if (sp.state && !states.includes(sp.state)) states.unshift(sp.state);
    const owners = [...new Map(all.filter((r) => r.owner_id).map((r) => [r.owner_id!, r.owner_name ?? r.owner_id!])).entries()].sort((a, b) =>
        a[1].localeCompare(b[1]),
    );
    if (sp.spoc_id && !owners.some(([id]) => id === sp.spoc_id)) owners.unshift([sp.spoc_id, "Selected person"]);
    const csvHref = `/api/admin/reports/needs-action/${k}${qs.toString() ? `?${qs}` : ""}`;
    const anyFilter = Boolean(sp.q || sp.state || sp.spoc_id || (sp.team && sp.team !== "all"));
    const hasValue = rows.some((r) => r.value != null);
    const total = rows.reduce((a, r) => a + (r.value ?? 0), 0);
    const back = user.role === "sales_head" ? "/sales-head" : "/admin/reports/sales-dashboard";
    const field = "min-h-10 rounded-[10px] border border-border bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-brand-teal";

    return (
        <div className="space-y-6 px-4 py-6 pb-12 sm:px-6 md:px-8">
            <div>
                <Link href={back} className="inline-flex items-center gap-1 text-xs font-semibold text-brand-sky hover:underline">
                    <ArrowLeft className="h-3.5 w-3.5" /> Sales Head dashboard
                </Link>
                <h1 className="mt-2 text-2xl font-bold tracking-tight text-brand-navy">{ACTION_TITLES[k]}</h1>
                <p className="mt-1 max-w-3xl text-sm text-ink-muted">{RULE[k]}</p>
            </div>

            <form method="get" className="flex flex-wrap items-center gap-2.5 rounded-[14px] border border-border bg-surface px-3.5 py-3">
                <input
                    type="search"
                    name="q"
                    defaultValue={sp.q ?? ""}
                    placeholder="Search dealer, city, owner…"
                    aria-label="Search"
                    className={`${field} w-full sm:w-64`}
                />
                <select name="state" defaultValue={sp.state ?? ""} aria-label="State" className={field}>
                    <option value="">All states</option>
                    {states.map((st) => (
                        <option key={st} value={st}>
                            {st}
                        </option>
                    ))}
                </select>
                {k !== "sales_ready" && (
                    <>
                        <select name="spoc_id" defaultValue={sp.spoc_id ?? ""} aria-label="Person" className={`${field} max-w-[220px]`}>
                            <option value="">Everyone</option>
                            {owners.map(([id, name]) => (
                                <option key={id} value={id}>
                                    {name}
                                </option>
                            ))}
                        </select>
                        <select name="team" defaultValue={sp.team ?? "all"} aria-label="Team" className={field}>
                            <option value="all">Whole team</option>
                            <option value="field">Field (ASM)</option>
                            <option value="inside">Inside sales (ISR)</option>
                        </select>
                    </>
                )}
                <button type="submit" className="min-h-10 rounded-[10px] bg-brand-navy px-4 text-[13px] font-semibold text-white hover:bg-brand-800">
                    Apply
                </button>
                {anyFilter && (
                    <Link href={`/admin/reports/needs-action/${k}`} className="text-[13px] font-semibold text-brand-sky hover:underline">
                        Clear
                    </Link>
                )}
                <a
                    href={csvHref}
                    download
                    className="ml-auto inline-flex min-h-10 items-center gap-1.5 rounded-[10px] border border-border px-3 text-[13px] font-semibold text-brand-navy hover:bg-bg"
                >
                    <Download className="h-3.5 w-3.5" aria-hidden /> Download CSV
                </a>
            </form>

            <p className="text-xs text-ink-muted">
                {rows.length} lead{rows.length === 1 ? "" : "s"}
                {anyFilter ? ` of ${all.length}` : ""}
                {hasValue ? ` · ${inr(total)}` : ""}
            </p>

            {rows.length === 0 ? (
                <p className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">
                    {anyFilter ? "No leads match these filters." : "Nothing here right now."}
                </p>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
                    <table className="min-w-full text-sm">
                        <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                            <tr>
                                <th className="px-4 py-3">Dealer</th>
                                <th className="px-4 py-3">Location</th>
                                <th className="px-4 py-3">{k === "visit_overdue" ? "ASM / owner" : "Owner"}</th>
                                <th className="px-4 py-3">Why it is here</th>
                                {hasValue && <th className="px-4 py-3 text-right">Value</th>}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                            {rows.map((r) => (
                                <tr key={r.lead_id} className="align-top">
                                    <td className="px-4 py-3">
                                        <Link
                                            href={`/inside-sales/lead/${encodeURIComponent(r.lead_id)}`}
                                            className="font-medium text-gray-900 hover:text-brand-sky hover:underline"
                                        >
                                            {r.dealer}
                                        </Link>
                                    </td>
                                    <td className="px-4 py-3 text-gray-700">{[r.city, r.state].filter(Boolean).join(", ") || "—"}</td>
                                    <td className="px-4 py-3 text-gray-700">{r.owner_name ?? "—"}</td>
                                    <td className="px-4 py-3 text-gray-700">{r.detail}</td>
                                    {hasValue && (
                                        <td className="whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums text-gray-900">
                                            {r.value == null ? "—" : inr(r.value)}
                                        </td>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
