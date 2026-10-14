// "Waiting for a field visit" — ageing now and two periods side by side, so the
// Sales Head can see whether the visit queue is shrinking and whether ASMs are
// visiting sooner. Server-rendered; the period pickers are a plain GET form
// that keeps the list's own filters (src/lib/dashboard/fieldVisitTrend.ts).

import Link from "next/link";

import { cn } from "@/lib/utils";
import type { FieldVisitPeriod } from "@/lib/dashboard/fieldVisitTrend";

type Better = "lower" | "higher" | "none";

const fmtDay = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const range = (p: FieldVisitPeriod) => (p.from === p.to ? fmtDay(p.from) : `${fmtDay(p.from)} – ${fmtDay(p.to)}`);
const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : null);

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
    now,
    a,
    b,
    limitDays,
    hidden,
    presets,
}: {
    now: FieldVisitPeriod;
    a: FieldVisitPeriod;
    b: FieldVisitPeriod;
    limitDays: number;
    /** The list's own filters, carried through the period form. */
    hidden: Record<string, string>;
    presets: { label: string; href: string }[];
}) {
    const inLimitA = pct(a.visitedInLimit, a.visited);
    const inLimitB = pct(b.visitedInLimit, b.visited);
    const rows: { label: string; a: number | null; b: number | null; better: Better; unit?: string; show?: (v: number | null) => string }[] = [
        { label: "Waiting for a visit at the start", a: a.waitingAtStart, b: b.waitingAtStart, better: "lower" },
        { label: "Waiting for a visit at the end", a: a.waitingAtEnd, b: b.waitingAtEnd, better: "lower" },
        { label: `· of them past the limit (${limitDays} working days)`, a: a.overdueAtEnd, b: b.overdueAtEnd, better: "lower" },
        { label: "New transfers to an ASM", a: a.transferred, b: b.transferred, better: "none" },
        { label: "First visits done", a: a.visited, b: b.visited, better: "higher" },
        {
            label: "Visited within the limit",
            a: inLimitA,
            b: inLimitB,
            better: "higher",
            unit: " pts",
            show: (v) => (v == null ? "—" : `${v}%`),
        },
        {
            label: "Average working days to first visit",
            a: a.avgDaysToVisit,
            b: b.avgDaysToVisit,
            better: "lower",
            show: (v) => (v == null ? "—" : String(v)),
        },
        { label: "Left the queue without a visit", a: a.leftWithoutVisit, b: b.leftWithoutVisit, better: "none" },
    ];
    const queueDelta = b.waitingAtEnd - a.waitingAtEnd;
    const visitDelta = b.visited - a.visited;
    const field = "min-h-10 rounded-[10px] border border-border bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-brand-teal";
    const maxNow = Math.max(1, ...now.ageing.map((x) => x.count));

    return (
        <section className="space-y-4 rounded-[14px] border border-border bg-surface p-4 shadow-card sm:p-5">
            <div>
                <h2 className="text-base font-bold text-brand-navy">Ageing and comparison</h2>
                <p className="mt-0.5 text-xs text-ink-muted">
                    Every lead waiting for its first ASM visit, inside the limit or past it. Days are working days since the transfer
                    (Mon–Sat, holidays off). Past days are rebuilt from status changes and visits; the filters read each lead as it is
                    today.
                </p>
            </div>

            {/* Ageing now */}
            <div>
                <p className="text-[13px] font-semibold text-ink">
                    Waiting now: <span className="text-brand-navy">{now.waitingAtEnd}</span>
                    <span className="font-normal text-ink-muted"> · {now.overdueAtEnd} past the limit</span>
                </p>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                    {now.ageing.map((x) => (
                        <div key={x.label} className="rounded-[10px] border border-border px-3 py-2">
                            <div className="flex items-baseline justify-between gap-2">
                                <span className={cn("text-xl font-bold tabular-nums", x.overLimit && x.count > 0 ? "text-danger" : "text-brand-navy")}>
                                    {x.count}
                                </span>
                            </div>
                            <div className="text-[11.5px] leading-snug text-ink-muted">{x.label}</div>
                            <div className="mt-1.5 h-1.5 rounded-full bg-bg">
                                <div
                                    className={cn("h-1.5 rounded-full", x.overLimit ? "bg-danger" : "bg-success")}
                                    style={{ width: `${(x.count / maxNow) * 100}%` }}
                                />
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Period pickers */}
            <form method="get" className="flex flex-wrap items-end gap-2.5 border-t border-border pt-4">
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
                Leads waiting for a visit went from <b>{a.waitingAtEnd}</b> to <b>{b.waitingAtEnd}</b>{" "}
                <span className={cn("font-semibold", queueDelta < 0 ? "text-success" : queueDelta > 0 ? "text-danger" : "text-ink-muted")}>
                    ({queueDelta === 0 ? "no change" : queueDelta < 0 ? `down ${-queueDelta}` : `up ${queueDelta}`})
                </span>
                ; first visits done went from <b>{a.visited}</b> to <b>{b.visited}</b>{" "}
                <span className={cn("font-semibold", visitDelta > 0 ? "text-success" : visitDelta < 0 ? "text-danger" : "text-ink-muted")}>
                    ({visitDelta === 0 ? "no change" : visitDelta > 0 ? `up ${visitDelta}` : `down ${-visitDelta}`})
                </span>
                .
            </p>

            {/* Side by side */}
            <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-[13px]">
                    <thead>
                        <tr className="border-b border-border text-left text-[11.5px] uppercase tracking-wide text-ink-muted">
                            <th className="py-2 pr-3 font-semibold">Measure</th>
                            <th className="py-2 pr-3 text-right font-semibold">A · {range(a)}</th>
                            <th className="py-2 pr-3 text-right font-semibold">B · {range(b)}</th>
                            <th className="py-2 text-right font-semibold">B vs A</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr key={r.label} className="border-b border-border/60">
                                <td className="py-2 pr-3">{r.label}</td>
                                <td className="py-2 pr-3 text-right tabular-nums">{r.show ? r.show(r.a) : r.a}</td>
                                <td className="py-2 pr-3 text-right tabular-nums">{r.show ? r.show(r.b) : r.b}</td>
                                <td className="py-2 text-right tabular-nums">
                                    <Change a={r.a} b={r.b} better={r.better} unit={r.unit} />
                                </td>
                            </tr>
                        ))}
                        <tr>
                            <td colSpan={4} className="pt-4 pb-1 text-[11.5px] font-semibold uppercase tracking-wide text-ink-muted">
                                Still waiting at the end, by age
                            </td>
                        </tr>
                        {b.ageing.map((x, i) => (
                            <tr key={x.label} className="border-b border-border/60">
                                <td className={cn("py-2 pr-3", x.overLimit && "text-danger")}>{x.label}</td>
                                <td className="py-2 pr-3 text-right tabular-nums">{a.ageing[i]?.count ?? 0}</td>
                                <td className="py-2 pr-3 text-right tabular-nums">{x.count}</td>
                                <td className="py-2 text-right tabular-nums">
                                    <Change a={a.ageing[i]?.count ?? 0} b={x.count} better={x.overLimit ? "lower" : "none"} />
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </section>
    );
}
