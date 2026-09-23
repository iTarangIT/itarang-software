import type { ReactNode } from "react";

/**
 * A single headline number.
 *
 * The VALUE stays in ink and the status is carried by a labelled chip beside it,
 * never by recolouring the numeral. Two reasons: a wall of red digits stops
 * being scannable once more than one tile is unhappy, and a state encoded only
 * as a colour is invisible to a colourblind viewer. The chip is a dot AND a
 * word, so it survives both.
 */
export type Tone = "neutral" | "good" | "warning" | "critical" | "unknown";

const TONE: Record<Tone, { rule: string; dot: string; chip: string }> = {
    neutral: { rule: "bg-slate-300", dot: "bg-slate-400", chip: "text-slate-500" },
    good: { rule: "bg-emerald-500", dot: "bg-emerald-500", chip: "text-emerald-700" },
    warning: { rule: "bg-amber-500", dot: "bg-amber-500", chip: "text-amber-700" },
    critical: { rule: "bg-red-600", dot: "bg-red-600", chip: "text-red-700" },
    unknown: { rule: "bg-slate-200", dot: "bg-slate-300", chip: "text-slate-400" },
};

export function KpiTile({
    label,
    value,
    unit,
    sub,
    tone = "neutral",
    status,
}: {
    label: string;
    /** Pass null for "not measured" — it renders as an em dash, never as 0. */
    value: number | string | null;
    unit?: string;
    sub?: ReactNode;
    tone?: Tone;
    status?: string;
}) {
    const t = TONE[value === null ? "unknown" : tone];

    return (
        <div className="relative bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <span className={`absolute left-0 top-0 h-full w-1 ${t.rule}`} aria-hidden />
            <div className="p-5 pl-6">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                    {label}
                </p>
                <p className="mt-2 text-4xl font-semibold text-gray-900 leading-none tabular-nums">
                    {value === null ? "—" : value}
                    {unit && value !== null && (
                        <span className="text-base font-medium text-gray-400 ml-1.5">{unit}</span>
                    )}
                </p>
                <div className="mt-2.5 flex items-center gap-2 min-h-[18px]">
                    {status && (
                        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${t.chip}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} aria-hidden />
                            {status}
                        </span>
                    )}
                    {sub && <span className="text-xs text-gray-400 truncate">{sub}</span>}
                </div>
            </div>
        </div>
    );
}
