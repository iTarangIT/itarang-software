"use client";

// "Waiting for a field visit" — two periods side by side, per ASM with team
// subtotals and a company total (ID 190, decision 14-15 Oct). Every number opens
// the leads behind it, with a CSV (sales-drill fv_* kinds — the same query that
// counts them, src/lib/dashboard/fieldVisitTrend.ts). The period pickers are a
// plain GET form that keeps the list's own filters.

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
    | "fv_moved"
    | "fv_waiting"
    | "fv_past_limit";

const fmtDay = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const range = (p: FieldVisitPeriod) => (p.from === p.to ? fmtDay(p.from) : `${fmtDay(p.from)} – ${fmtDay(p.to)}`);
const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : null);
const pctVisited = (c: FieldVisitCounts) => pct(c.visited, c.pending + c.new);
const NO_PERSON = "__none__";

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

export function FieldVisitTrend({
    a,
    b,
    hidden,
    presets,
}: {
    a: FieldVisitPeriod;
    b: FieldVisitPeriod;
    /** The list's own filters (state, spoc_id, team, q), carried through the period form and into the drill lists. */
    hidden: Record<string, string>;
    presets: { label: string; href: string }[];
}) {
    const [drill, setDrill] = useState<SalesDrillTarget | null>(null);
    const [which, setWhich] = useState<"a" | "b">("b");

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
    }: {
        kind: Kind;
        p: FieldVisitPeriod;
        n: number;
        title: string;
        persons?: string[] | null;
        danger?: boolean;
    }) =>
        n > 0 ? (
            <button
                type="button"
                onClick={() => open(kind, p, n, title, persons)}
                className={cn("font-semibold tabular-nums underline-offset-2 hover:underline", danger ? "text-danger" : "text-brand-sky")}
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
        { label: "Left without a visit (not needed, handed back, Lost)", kind: "fv_left", get: (c) => c.left, better: "none" },
        { label: "Moved on without a visit (another ASM, quote approved, …)", kind: "fv_moved", get: (c) => c.moved, better: "none" },
        { label: "Still waiting at the end", kind: "fv_waiting", get: (c) => c.waiting, better: "lower" },
        { label: "of them past the limit", kind: "fv_past_limit", get: (c) => c.pastLimit, better: "lower", indent: true, danger: true },
    ];
    const queueDelta = b.total.waiting - a.total.waiting;
    const visitDelta = b.total.visited - a.total.visited;
    const field = "min-h-10 rounded-[10px] border border-border bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-brand-teal";
    const per = which === "a" ? a : b;

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
        { label: "Left, no visit", kind: "fv_left", get: (c) => c.left },
        { label: "Moved on", kind: "fv_moved", get: (c) => c.moved },
        { label: "Still waiting", kind: "fv_waiting", get: (c) => c.waiting },
        { label: "Past the limit", kind: "fv_past_limit", get: (c) => c.pastLimit, danger: true },
    ];
    const personRow = (r: FieldVisitRow, persons: string[] | null, tone: "asm" | "team" | "total") => (
        <tr
            key={`${tone}-${r.id ?? "none"}`}
            className={cn("border-b border-border/60", tone === "team" && "bg-bg/60", tone === "total" && "bg-bg font-semibold")}
        >
            <td className={cn("py-2 pr-3", tone !== "asm" && "font-semibold")}>{r.name}</td>
            {COLS.map((c) => (
                <td key={c.kind} className="py-2 pr-3 text-right">
                    {num({ kind: c.kind, p: per, n: c.get(r), title: `${c.label} · ${r.name}`, persons, danger: c.danger })}
                </td>
            ))}
            <td className="py-2 text-right tabular-nums">{pctVisited(r) == null ? "—" : `${pctVisited(r)}%`}</td>
        </tr>
    );

    return (
        <section className="space-y-4 rounded-[14px] border border-border bg-surface p-4 shadow-card sm:p-5">
            <div>
                <h2 className="text-base font-bold text-brand-navy">Compare two periods</h2>
                <p className="mt-0.5 text-xs text-ink-muted">
                    For each period: leads waiting at the start, plus leads moved to an ASM in it (a move from one ASM to another is new
                    for the new ASM), equals the leads visited, those that left without a visit (visit not needed, handed back to the
                    ISR, or Lost), those that moved on otherwise, and those still waiting at the end. % visited = visited ÷ (waiting at
                    the start + new). &ldquo;Past the limit&rdquo; uses working days since the transfer (Mon–Sat, holidays off) and the
                    limit in force on the transfer&apos;s day. Click any number for the leads.
                </p>
            </div>

            {/* Period pickers */}
            <form method="get" className="flex flex-wrap items-end gap-2.5">
                {Object.entries(hidden).map(([k, v]) => (
                    <input key={k} type="hidden" name={k} value={v} />
                ))}
                <fieldset className="flex flex-wrap items-center gap-1.5">
                    <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Period A</legend>
                    <input type="date" name="a_from" defaultValue={a.from} aria-label="Period A from" className={field} />
                    <span className="text-xs text-ink-muted">to</span>
                    <input type="date" name="a_to" defaultValue={a.to} aria-label="Period A to" className={field} />
                </fieldset>
                <fieldset className="flex flex-wrap items-center gap-1.5">
                    <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Period B</legend>
                    <input type="date" name="b_from" defaultValue={b.from} aria-label="Period B from" className={field} />
                    <span className="text-xs text-ink-muted">to</span>
                    <input type="date" name="b_to" defaultValue={b.to} aria-label="Period B to" className={field} />
                </fieldset>
                <button type="submit" className="min-h-10 rounded-[10px] bg-brand-navy px-4 text-[13px] font-semibold text-white hover:bg-brand-800">
                    Compare
                </button>
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
                            <th className="py-2 pr-3 text-right font-semibold">A · {range(a)}</th>
                            <th className="py-2 pr-3 text-right font-semibold">B · {range(b)}</th>
                            <th className="py-2 text-right font-semibold">B vs A</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr key={r.label} className="border-b border-border/60">
                                <td className={cn("py-2 pr-3", r.indent && "pl-4 text-ink-muted")}>{r.indent ? `· ${r.label}` : r.label}</td>
                                <td className="py-2 pr-3 text-right">{cell(r, a)}</td>
                                <td className="py-2 pr-3 text-right">{cell(r, b)}</td>
                                <td className="py-2 text-right tabular-nums">
                                    <Change a={r.get(a.total)} b={r.get(b.total)} better={r.better} unit={r.unit} />
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Per ASM, team subtotals and the company total, for one period */}
            <div className="space-y-2 border-t border-border pt-4">
                <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[13px] font-bold text-brand-navy">By ASM</h3>
                    <div className="inline-flex rounded-[10px] border border-border p-0.5 text-[12.5px]">
                        {(["a", "b"] as const).map((k) => (
                            <button
                                key={k}
                                type="button"
                                onClick={() => setWhich(k)}
                                className={cn(
                                    "rounded-[8px] px-2.5 py-1 font-semibold",
                                    which === k ? "bg-brand-navy text-white" : "text-ink-muted hover:text-ink",
                                )}
                            >
                                {k.toUpperCase()} · {range(k === "a" ? a : b)}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[860px] text-[13px]">
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
                            {per.asms.length === 0 ? (
                                <tr>
                                    <td colSpan={COLS.length + 2} className="py-3 text-ink-muted">
                                        No lead was waiting for a field visit in this period.
                                    </td>
                                </tr>
                            ) : (
                                per.asms.map((r) => personRow(r, [r.id ?? NO_PERSON], "asm"))
                            )}
                            {per.teams.map((t) => personRow(t, t.members ?? [], "team"))}
                            {per.asms.length > 0 && personRow({ ...per.total, id: null, name: "Company total" }, null, "total")}
                        </tbody>
                    </table>
                </div>
            </div>

            {drill && <SalesDrillModal target={drill} onClose={() => setDrill(null)} />}
        </section>
    );
}
