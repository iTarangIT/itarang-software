"use client";

// "Waiting for a field visit" — this period and the previous period of the
// same length side by side, per ASM with team subtotals and a company total
// (ID 190, decision 14-15 Oct; 18 Oct sheet: both periods on every ASM's row,
// the previous one set automatically — no A / B switch). Every number opens
// the leads behind it, with a CSV (sales-drill fv_* kinds — the same query
// that counts them, src/lib/dashboard/fieldVisitTrend.ts). The period picker
// is a plain GET form that keeps the list's own filters.

import { useState } from "react";
import Link from "next/link";

import { cn } from "@/lib/utils";
import { SalesDrillModal, type SalesDrillTarget } from "@/components/dashboard/sales/SalesDrillModal";
import type { FieldVisitCounts, FieldVisitPeriod, FieldVisitRow } from "@/lib/dashboard/fieldVisitTrend";

type Better = "lower" | "higher" | "none";
type Kind =
    | "fv_pending"
    | "fv_new"
    | "fv_visited"
    | "fv_visited_backlog"
    | "fv_visited_new"
    | "fv_left"
    | "fv_waiting"
    | "fv_past_limit";

const fmtDay = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const range = (p: FieldVisitPeriod) => (p.from === p.to ? fmtDay(p.from) : `${fmtDay(p.from)} – ${fmtDay(p.to)}`);
const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : null);
const pctVisited = (c: FieldVisitCounts) => pct(c.visited, c.pending + c.new);
const NO_PERSON = "__none__";
const ZERO: FieldVisitCounts = {
    pending: 0,
    new: 0,
    visited: 0,
    visitedBacklog: 0,
    visitedNew: 0,
    visitedInLimit: 0,
    left: 0,
    moved: 0,
    waiting: 0,
    pastLimit: 0,
    avgDaysToVisit: null,
};

function Change({ a, b, better, unit = "" }: { a: number | null; b: number | null; better: Better; unit?: string }) {
    if (a == null || b == null) return <span className="text-ink-muted">—</span>;
    const d = Math.round((b - a) * 10) / 10;
    if (d === 0) return <span className="text-ink-muted">no change</span>;
    const good = better === "none" ? null : better === "lower" ? d < 0 : d > 0;
    return (
        <span className={cn("font-semibold", good == null ? "text-ink" : good ? "text-success" : "text-danger")}>
            {d > 0 ? "▲" : "▼"} {Math.abs(d)}
            {unit}
        </span>
    );
}

/** One person (or team / company) with both periods. */
type Pair = { id: string | null; name: string; now: FieldVisitCounts | null; prev: FieldVisitCounts | null; persons: string[] | null };

/** Rows of this period and the previous one matched by person; one present in only one period reads 0 in the other. */
function pairUp(cur: FieldVisitRow[], old: FieldVisitRow[], persons: (r: FieldVisitRow) => string[] | null): Pair[] {
    const key = (r: FieldVisitRow) => r.id ?? NO_PERSON;
    const out = new Map<string, Pair>();
    for (const r of cur) out.set(key(r), { id: r.id, name: r.name, now: r, prev: null, persons: persons(r) });
    for (const r of old) {
        const p = out.get(key(r));
        if (p) p.prev = r;
        else out.set(key(r), { id: r.id, name: r.name, now: null, prev: r, persons: persons(r) });
    }
    return [...out.values()];
}

export function FieldVisitTrend({
    a,
    b,
    hidden,
    presets,
}: {
    /** The previous period: the same number of days right before `b`. */
    a: FieldVisitPeriod;
    /** This period. */
    b: FieldVisitPeriod;
    /** The list's own filters (state, spoc_id, team, q), carried through the period form and into the drill lists. */
    hidden: Record<string, string>;
    presets: { label: string; href: string }[];
}) {
    const [drill, setDrill] = useState<SalesDrillTarget | null>(null);

    /** Open the leads behind one number: `persons` = an ASM, a team, or null for everyone. */
    const open = (kind: Kind, p: FieldVisitPeriod, count: number, title: string, persons: string[] | null) => {
        if (count <= 0) return;
        const q = new URLSearchParams({ kind, from: p.from, to: p.to });
        for (const k of ["state", "spoc_id", "team"]) if (hidden[k]) q.set(k, hidden[k]);
        if (persons?.length) q.set("persons", persons.join(","));
        setDrill({ title: `${title} · ${range(p)}`, count, query: q.toString() });
    };

    const num = ({
        kind,
        p,
        n,
        title,
        persons = null,
        danger = false,
        muted = false,
    }: {
        kind: Kind;
        p: FieldVisitPeriod;
        n: number;
        title: string;
        persons?: string[] | null;
        danger?: boolean;
        muted?: boolean;
    }) =>
        n > 0 ? (
            <button
                type="button"
                onClick={() => open(kind, p, n, title, persons)}
                className={cn(
                    "tabular-nums underline-offset-2 hover:underline",
                    muted ? "text-ink-muted" : "font-semibold",
                    !muted && (danger ? "text-danger" : "text-brand-sky"),
                )}
            >
                {n}
            </button>
        ) : (
            <span className="tabular-nums text-ink-muted">0</span>
        );

    type Row = {
        label: string;
        kind?: Kind;
        get: (c: FieldVisitCounts) => number | null;
        better: Better;
        unit?: string;
        show?: (v: number | null) => string;
        indent?: boolean;
        danger?: boolean;
    };
    const rows: Row[] = [
        { label: "Waiting for a visit at the start", kind: "fv_pending", get: (c) => c.pending, better: "lower" },
        { label: "Moved to an ASM in the period", kind: "fv_new", get: (c) => c.new, better: "none" },
        { label: "First visits done", kind: "fv_visited", get: (c) => c.visited, better: "higher" },
        { label: "of the leads waiting at the start", kind: "fv_visited_backlog", get: (c) => c.visitedBacklog, better: "higher", indent: true },
        { label: "of the leads new in the period", kind: "fv_visited_new", get: (c) => c.visitedNew, better: "higher", indent: true },
        {
            label: "% visited (of waiting at the start + new)",
            get: pctVisited,
            better: "higher",
            unit: " pts",
            show: (v) => (v == null ? "—" : `${v}%`),
        },
        {
            label: "Visits within the limit",
            get: (c) => pct(c.visitedInLimit, c.visited),
            better: "higher",
            unit: " pts",
            show: (v) => (v == null ? "—" : `${v}%`),
        },
        {
            label: "Average working days to first visit",
            get: (c) => c.avgDaysToVisit,
            better: "lower",
            show: (v) => (v == null ? "—" : String(v)),
        },
        {
            label: "Closed without a visit (not needed, handed back, Lost, moved on)",
            kind: "fv_left",
            get: (c) => c.left,
            better: "none",
        },
        { label: "Still waiting at the end", kind: "fv_waiting", get: (c) => c.waiting, better: "lower" },
        { label: "of them past the limit", kind: "fv_past_limit", get: (c) => c.pastLimit, better: "lower", indent: true, danger: true },
    ];
    const queueDelta = b.total.waiting - a.total.waiting;
    const visitDelta = b.total.visited - a.total.visited;
    const field = "min-h-10 rounded-[10px] border border-border bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-brand-teal";

    const cell = (r: Row, p: FieldVisitPeriod) => {
        const v = r.get(p.total);
        if (r.kind && v != null) return num({ kind: r.kind, p, n: v, title: r.label, danger: r.danger });
        return <span className="tabular-nums">{r.show ? r.show(v) : v}</span>;
    };

    const COLS: { label: string; kind: Kind; get: (c: FieldVisitCounts) => number; danger?: boolean }[] = [
        { label: "Waiting at start", kind: "fv_pending", get: (c) => c.pending },
        { label: "New", kind: "fv_new", get: (c) => c.new },
        { label: "Visited", kind: "fv_visited", get: (c) => c.visited },
        { label: "· of backlog", kind: "fv_visited_backlog", get: (c) => c.visitedBacklog },
        { label: "· of new", kind: "fv_visited_new", get: (c) => c.visitedNew },
        { label: "Closed, no visit", kind: "fv_left", get: (c) => c.left },
        { label: "Still waiting", kind: "fv_waiting", get: (c) => c.waiting },
        { label: "Past the limit", kind: "fv_past_limit", get: (c) => c.pastLimit, danger: true },
    ];
    const asmPairs = pairUp(b.asms, a.asms, (r) => [r.id ?? NO_PERSON]);
    const teamPairs = pairUp(b.teams, a.teams, (r) => r.members ?? []).sort((x, y) => x.name.localeCompare(y.name));
    const pctText = (c: FieldVisitCounts | null) => {
        const v = c ? pctVisited(c) : null;
        return v == null ? "—" : `${v}%`;
    };
    const personRow = (pr: Pair, tone: "asm" | "team" | "total") => (
        <tr
            key={`${tone}-${pr.id ?? "none"}`}
            className={cn("border-b border-border/60", tone === "team" && "bg-bg/60", tone === "total" && "bg-bg font-semibold")}
        >
            <td className={cn("py-2 pr-3", tone !== "asm" && "font-semibold")}>{pr.name}</td>
            {COLS.map((c) => (
                <td key={c.kind} className="whitespace-nowrap py-2 pr-3 text-right">
                    {num({ kind: c.kind, p: b, n: c.get(pr.now ?? ZERO), title: `${c.label} · ${pr.name}`, persons: pr.persons, danger: c.danger })}
                    <span className="mx-1 text-ink-muted" aria-hidden>
                        |
                    </span>
                    {num({ kind: c.kind, p: a, n: c.get(pr.prev ?? ZERO), title: `${c.label} · ${pr.name}`, persons: pr.persons, muted: true })}
                </td>
            ))}
            <td className="whitespace-nowrap py-2 text-right tabular-nums">
                {pctText(pr.now)} <span className="text-ink-muted">| {pctText(pr.prev)}</span>
            </td>
        </tr>
    );

    return (
        <section className="space-y-4 rounded-[14px] border border-border bg-surface p-4 shadow-card sm:p-5">
            <div>
                <h2 className="text-base font-bold text-brand-navy">This period against the previous one</h2>
                <p className="mt-0.5 text-xs text-ink-muted">
                    The previous period is the same number of days right before this one, set automatically. For each period: leads
                    waiting at the start, plus leads moved to an ASM in it, equals the leads visited, those closed without a visit
                    (visit not needed, handed back to the ISR, Lost, or moved on — to another ASM, where it is new for that ASM, a quote
                    approved, …), and those still waiting at the end. % visited = visited ÷ (waiting at the start + new). &ldquo;Past
                    the limit&rdquo; uses working days since the transfer (office calendar, holidays off) and the limit in force on the
                    transfer&apos;s day. Click any number for the leads.
                </p>
            </div>

            {/* Period picker: the previous period follows it */}
            <form method="get" className="flex flex-wrap items-end gap-2.5">
                {Object.entries(hidden).map(([k, v]) => (
                    <input key={k} type="hidden" name={k} value={v} />
                ))}
                <fieldset className="flex flex-wrap items-center gap-1.5">
                    <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Period</legend>
                    <input type="date" name="from" defaultValue={b.from} aria-label="Period from" className={field} />
                    <span className="text-xs text-ink-muted">to</span>
                    <input type="date" name="to" defaultValue={b.to} aria-label="Period to" className={field} />
                </fieldset>
                <button type="submit" className="min-h-10 rounded-[10px] bg-brand-navy px-4 text-[13px] font-semibold text-white hover:bg-brand-800">
                    Show
                </button>
                <span className="pb-2.5 text-xs text-ink-muted">Previous period: {range(a)}</span>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12.5px]">
                    {presets.map((p) => (
                        <Link key={p.label} href={p.href} className="font-semibold text-brand-sky hover:underline">
                            {p.label}
                        </Link>
                    ))}
                </div>
            </form>

            {/* Verdict */}
            <p className="text-[13px] text-ink">
                Leads still waiting for a visit went from <b>{a.total.waiting}</b> to <b>{b.total.waiting}</b>{" "}
                <span className={cn("font-semibold", queueDelta < 0 ? "text-success" : queueDelta > 0 ? "text-danger" : "text-ink-muted")}>
                    ({queueDelta === 0 ? "no change" : queueDelta < 0 ? `down ${-queueDelta}` : `up ${queueDelta}`})
                </span>
                ; first visits done went from <b>{a.total.visited}</b> to <b>{b.total.visited}</b>{" "}
                <span className={cn("font-semibold", visitDelta > 0 ? "text-success" : visitDelta < 0 ? "text-danger" : "text-ink-muted")}>
                    ({visitDelta === 0 ? "no change" : visitDelta > 0 ? `up ${visitDelta}` : `down ${-visitDelta}`})
                </span>
                .
            </p>

            {/* Company total, side by side */}
            <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-[13px]">
                    <thead>
                        <tr className="border-b border-border text-left text-[11.5px] uppercase tracking-wide text-ink-muted">
                            <th className="py-2 pr-3 font-semibold">Measure (company)</th>
                            <th className="py-2 pr-3 text-right font-semibold">This period · {range(b)}</th>
                            <th className="py-2 pr-3 text-right font-semibold">Previous · {range(a)}</th>
                            <th className="py-2 text-right font-semibold">Change</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr key={r.label} className="border-b border-border/60">
                                <td className={cn("py-2 pr-3", r.indent && "pl-4 text-ink-muted")}>{r.indent ? `· ${r.label}` : r.label}</td>
                                <td className="py-2 pr-3 text-right">{cell(r, b)}</td>
                                <td className="py-2 pr-3 text-right">{cell(r, a)}</td>
                                <td className="py-2 text-right tabular-nums">
                                    <Change a={r.get(a.total)} b={r.get(b.total)} better={r.better} unit={r.unit} />
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Per ASM, team subtotals and the company total — both periods on every row */}
            <div className="space-y-2 border-t border-border pt-4">
                <div className="flex flex-wrap items-baseline gap-2">
                    <h3 className="text-[13px] font-bold text-brand-navy">By ASM</h3>
                    <span className="text-xs text-ink-muted">
                        Each cell: this period ({range(b)}) | previous period ({range(a)}).
                    </span>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[960px] text-[13px]">
                        <thead>
                            <tr className="border-b border-border text-left text-[11.5px] uppercase tracking-wide text-ink-muted">
                                <th className="py-2 pr-3 font-semibold">ASM</th>
                                {COLS.map((c) => (
                                    <th key={c.kind} className="py-2 pr-3 text-right font-semibold">
                                        {c.label}
                                    </th>
                                ))}
                                <th className="py-2 text-right font-semibold">% visited</th>
                            </tr>
                        </thead>
                        <tbody>
                            {asmPairs.length === 0 ? (
                                <tr>
                                    <td colSpan={COLS.length + 2} className="py-3 text-ink-muted">
                                        No lead was waiting for a field visit in either period.
                                    </td>
                                </tr>
                            ) : (
                                asmPairs.map((pr) => personRow(pr, "asm"))
                            )}
                            {teamPairs.map((pr) => personRow(pr, "team"))}
                            {asmPairs.length > 0 &&
                                personRow({ id: null, name: "Company total", now: b.total, prev: a.total, persons: null }, "total")}
                        </tbody>
                    </table>
                </div>
            </div>

            {drill && <SalesDrillModal target={drill} onClose={() => setDrill(null)} />}
        </section>
    );
}
