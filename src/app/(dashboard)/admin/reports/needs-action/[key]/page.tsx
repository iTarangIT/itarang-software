// The list behind one Sales Head "Needs action now" tile — the same rows the
// tile counts (src/lib/dashboard/salesHeadActions.ts), with the dashboard's
// filters carried over in the URL. Each row opens the lead (mark Won, …) and
// carries Call and Assign / Reassign itself (NeedsActionTable, ID 88 #3). The filter bar is a plain GET form, and
// "Download CSV" sends the same query string to the API, so the file holds
// exactly the rows on screen.

import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download } from "lucide-react";

import { requireRole } from "@/lib/auth-utils";
import {
    ACTION_KEYS,
    actionScopeFrom,
    ACTION_TITLES,
    listSalesHeadAction,
    listSalesHeadActionFiltered,
    phonesForActionRows,
    type ActionKey,
} from "@/lib/dashboard/salesHeadActions";
import { LEADS_BULK_ROLES } from "@/lib/leads/access";
import { formatLimit, type TimeLimits } from "@/lib/timeLimits/registry";
import { getTimeLimits } from "@/lib/timeLimits/store";
import { NeedsActionTable } from "./NeedsActionTable";
import { FieldVisitTrend } from "./FieldVisitTrend";
import { dayOr, fieldVisitPeriod, istToday, shiftDay } from "@/lib/dashboard/fieldVisitTrend";

export const dynamic = "force-dynamic";

const inr = (n: number) =>
    n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(2)} L` : `₹${Math.round(n).toLocaleString("en-IN")}`;

// The rule each list follows, with the time limits in force today (ID 85).
const rules = (l: TimeLimits): Record<ActionKey, string> => ({
    sales_ready: "Leads marked sales-ready that nobody owns yet. Assign them from Ready to Assign.",
    hot_not_called:
        `Hot leads with an owner and no call or visit since the owner got the lead, more than ${formatLimit(l.owner_first_attempt, "working_hours")} ago (Mon–Sat, 10:00–19:00 IST, holidays off). Leads with an ASM for a visit, and dead / non-responsive numbers, are left out.`,
    visit_overdue: `Leads transferred to an ASM whose first visit is past the limit (${formatLimit(l.asm_transfer_first_visit, "working_days")}), with no visit marked since the transfer.`,
    quotes_no_answer:
        `The lead's latest quote was delivered to the dealer more than ${formatLimit(l.quote_no_answer, "working_days")} ago and the dealer has neither approved nor declined it. Withdrawn quotes and closed leads are left out.`,
    said_yes: "The dealer approved the quote, but the lead has not been marked Won.",
    onboarding_stalled:
        `Won leads whose onboarding has stopped: waiting on the dealer ${l.onboarding_stall_dealer}+ days, or waiting on us ${l.onboarding_stall_us}+ working days. Leads already in the ${l.onboarding_dropout}-day drop-out review are listed there instead.`,
    won_without_quote: "Leads marked Won this month with no quote the dealer approved. Check the price before onboarding.",
    hot_aged:
        "Open leads (not Converted or Lost) rated Hot for more than 7 days, counted from the day the lead became Hot. A Hot lead this old needs a decision: push it to a quote, transfer it for a visit, or re-rate it.",
    won_undo_requests:
        "A rep marked a lead Won by mistake and asked to undo it. Open the lead to approve (it goes back to its earlier stage, same owner) or refuse. Possible only until the dealer uploads any onboarding document; after that it is a drop-out. A request is cancelled on its own when the lead leaves Won.",
    won_undone_week:
        "Every Mark Won undone in the last 7 days: the lead went back to the stage it was at before Won, its empty onboarding application was withdrawn, and the Won is not counted anywhere.",
});

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
    const [rows, all, limits] = await Promise.all([
        listSalesHeadActionFiltered(k, qs),
        listSalesHeadAction(k, {}),
        getTimeLimits(),
    ]);
    // ID 88 #3 — the dealer's number for the row's Call button. Onboarding
    // stalled has no Call button (asked for on 13 Oct): no number, no button.
    const phones = k === "onboarding_stalled" ? {} : await phonesForActionRows(rows);
    const states = [...new Set(all.map((r) => r.state?.trim()).filter((v): v is string => !!v))].sort();
    if (sp.state && !states.includes(sp.state)) states.unshift(sp.state);
    const owners = [...new Map(all.filter((r) => r.owner_id).map((r) => [r.owner_id!, r.owner_name ?? r.owner_id!])).entries()].sort((a, b) =>
        a[1].localeCompare(b[1]),
    );
    if (sp.spoc_id && !owners.some(([id]) => id === sp.spoc_id)) owners.unshift([sp.spoc_id, "Selected person"]);
    // Waiting for a field visit: ageing now and two periods side by side.
    // Default: the last 7 days (B) against the 7 before them (A).
    const PERIOD_KEYS = ["a_from", "a_to", "b_from", "b_to"] as const;
    let trend: ReactNode = null;
    if (k === "visit_overdue") {
        const today = istToday();
        const bTo = dayOr(sp.b_to, today);
        const bFrom = dayOr(sp.b_from, shiftDay(bTo, -6));
        const aTo = dayOr(sp.a_to, shiftDay(bFrom, -1));
        const aFrom = dayOr(sp.a_from, shiftDay(aTo, -6));
        const scope = actionScopeFrom(qs);
        const [now, pa, pb] = await Promise.all([
            fieldVisitPeriod(scope, today, today),
            fieldVisitPeriod(scope, aFrom, aTo),
            fieldVisitPeriod(scope, bFrom, bTo),
        ]);
        const listFilters = Object.fromEntries(
            [...qs.entries()].filter(([key]) => !(PERIOD_KEYS as readonly string[]).includes(key)),
        );
        const preset = (label: string, a: [string, string], b: [string, string]) => ({
            label,
            href: `/admin/reports/needs-action/${k}?${new URLSearchParams({ ...listFilters, a_from: a[0], a_to: a[1], b_from: b[0], b_to: b[1] })}`,
        });
        const monthStart = `${today.slice(0, 8)}01`;
        const lastMonthEnd = shiftDay(monthStart, -1);
        const lastMonthStart = `${lastMonthEnd.slice(0, 8)}01`;
        const dom = Number(today.slice(8, 10));
        const lastMonthSameDay = shiftDay(lastMonthStart, Math.min(dom, Number(lastMonthEnd.slice(8, 10))) - 1);
        trend = (
            <FieldVisitTrend
                now={now}
                a={pa}
                b={pb}
                limitDays={limits.asm_transfer_first_visit}
                hidden={listFilters}
                presets={[
                    preset("Last 7 days vs the 7 before", [shiftDay(today, -13), shiftDay(today, -7)], [shiftDay(today, -6), today]),
                    preset("This month vs same days last month", [lastMonthStart, lastMonthSameDay], [monthStart, today]),
                ]}
            />
        );
    }
    const periodHidden = PERIOD_KEYS.filter((key) => sp[key]).map((key) => (
        <input key={key} type="hidden" name={key} value={sp[key]} />
    ));
    const csvHref = `/api/admin/reports/needs-action/${k}${qs.toString() ? `?${qs}` : ""}`;
    const anyFilter = Boolean(sp.q || sp.state || sp.spoc_id || (sp.team && sp.team !== "all"));
    const hasValue = rows.some((r) => r.value != null);
    const total = rows.reduce((a, r) => a + (r.value ?? 0), 0);
    const back = user.role === "sales_head" ? "/sales-head" : user.role === "admin" ? "/admin" : "/admin/reports/sales-dashboard";
    const field = "min-h-10 rounded-[10px] border border-border bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-brand-teal";

    return (
        <div className="space-y-6 px-4 py-6 pb-12 sm:px-6 md:px-8">
            <div>
                <Link href={back} className="inline-flex items-center gap-1 text-xs font-semibold text-brand-sky hover:underline">
                    <ArrowLeft className="h-3.5 w-3.5" /> Sales dashboard
                </Link>
                <h1 className="mt-2 text-2xl font-bold tracking-tight text-brand-navy">{ACTION_TITLES[k]}</h1>
                <p className="mt-1 max-w-3xl text-sm text-ink-muted">{rules(limits)[k]}</p>
            </div>

            {trend}

            <form method="get" className="flex flex-wrap items-center gap-2.5 rounded-[14px] border border-border bg-surface px-3.5 py-3">
                {periodHidden}
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
                // ID 88 #3 — call, assign and reassign on the row (the undo-Won
                // tiles are decided on the lead, so they get Call only).
                <NeedsActionTable
                    rows={rows}
                    phones={phones}
                    ownerHeading={k === "visit_overdue" ? "ASM / owner" : "Owner"}
                    hasValue={hasValue}
                    canAssign={
                        (LEADS_BULK_ROLES as readonly string[]).includes(user.role) &&
                        k !== "won_undo_requests" &&
                        k !== "won_undone_week"
                    }
                />
            )}
        </div>
    );
}
