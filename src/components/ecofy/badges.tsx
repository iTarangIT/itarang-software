// Small presentational pieces shared by every Ecofy workspace screen (E-305/E-307).

import { ECOFY_STAGE_LABELS } from "@/lib/ecofy/access";

export function TemperatureBadge({ value }: { value: string | null }) {
    if (!value) return <span className="text-gray-400">—</span>;
    const hot = value === "HOT";
    return (
        <span
            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                hot ? "bg-red-50 text-red-700 ring-1 ring-red-200" : "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
            }`}
        >
            {hot ? "Hot" : value === "WARM" ? "Warm" : value}
        </span>
    );
}

const STAGE_TONE: Record<string, string> = {
    S0: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    S6: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    S8: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    S7: "bg-violet-50 text-violet-700 ring-violet-200",
    CLOSED: "bg-gray-100 text-gray-600 ring-gray-200",
};

export function StageBadge({ value, subStatus }: { value: string | null; subStatus?: string | null }) {
    if (!value) return <span className="text-gray-400">—</span>;
    const label = ECOFY_STAGE_LABELS[value];
    return (
        <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${
                STAGE_TONE[value] ?? "bg-sky-50 text-sky-700 ring-sky-200"
            }`}
        >
            {label ? `${value} · ${label}` : value}
            {subStatus ? <span className="opacity-70">· {subStatus.replace(/_/g, " ").toLowerCase()}</span> : null}
        </span>
    );
}

/** Which side executes each stage — mirrors Ecofy's case timeline. */
export const STAGE_RAIL = [
    { stage: "S0", label: "Qualification", owner: "Ecofy" },
    { stage: "S1", label: "Pickup queue", owner: "iTarang" },
    { stage: "S2", label: "Follow-up", owner: "iTarang" },
    { stage: "S3", label: "Assessment", owner: "iTarang" },
    { stage: "S4", label: "Offer", owner: "iTarang" },
    { stage: "S5", label: "File", owner: "iTarang" },
    { stage: "S6", label: "Financing", owner: "Ecofy" },
    { stage: "S7", label: "Installation", owner: "EPC" },
    { stage: "S8", label: "Asset", owner: "Ecofy" },
] as const;

/**
 * The 9-stage rail. `tone` colours the current node by whose turn it is
 * (green = the viewer acts, amber = waiting on another party, gray = done) and
 * `partyLabel` is pinned under it ("You are here" / "Pending: Ecofy"), so the
 * current step is never in doubt. Completed nodes stay ✓, the connector is
 * solid up to the current node and dashed after it.
 */
export function StageRail({
    stage,
    tone = "action",
    partyLabel,
}: {
    stage: string | null;
    tone?: "action" | "waiting" | "done";
    partyLabel?: string;
}) {
    const idx = stage === "CLOSED" ? STAGE_RAIL.length : STAGE_RAIL.findIndex((s) => s.stage === stage);
    // Brand gradient — same token as the profile hero band (--gradient-primary).
    const brandNode = "bg-[image:var(--gradient-primary)] text-white ring-4 ring-brand-200/70 shadow-md shadow-brand-300/50";
    const brandPill = "bg-[image:var(--gradient-primary)] text-white shadow-sm shadow-brand-300/50";
    const currentNode = {
        action: brandNode,
        waiting: "bg-amber-500 text-white ring-4 ring-amber-100",
        done: brandNode,
    }[tone];
    const currentPill = {
        action: brandPill,
        waiting: "bg-amber-500 text-white",
        done: brandPill,
    }[tone];
    return (
        <ol className="grid grid-cols-3 gap-y-3 sm:grid-cols-5 lg:grid-cols-9">
            {STAGE_RAIL.map((s, i) => {
                const done = idx > i;
                const current = idx === i;
                return (
                    <li key={s.stage} className="relative flex flex-col items-center text-center">
                        {/* connector to the previous node */}
                        {i > 0 && (
                            <span
                                aria-hidden
                                className={`absolute left-0 right-1/2 top-3.5 z-0 border-t-2 ${
                                    done || current ? "border-gray-900" : "border-dashed border-gray-300"
                                }`}
                            />
                        )}
                        {i < STAGE_RAIL.length - 1 && (
                            <span
                                aria-hidden
                                className={`absolute left-1/2 right-0 top-3.5 z-0 border-t-2 ${done ? "border-gray-900" : "border-dashed border-gray-300"}`}
                            />
                        )}
                        <span
                            className={`relative z-[1] flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${
                                current ? currentNode : done ? "bg-gray-900 text-white" : "border border-gray-300 bg-white text-gray-500"
                            }`}
                        >
                            {done ? "✓" : i}
                        </span>
                        <span className={`mt-1 text-[11px] ${current ? "font-semibold text-gray-900" : "text-gray-600"}`}>{s.label}</span>
                        <span
                            className={`text-[10px] font-medium uppercase tracking-wide ${
                                s.owner === "iTarang" ? "text-sky-600" : s.owner === "EPC" ? "text-violet-600" : "text-emerald-600"
                            }`}
                        >
                            {s.owner}
                        </span>
                        {current && partyLabel && (
                            <span className={`mt-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${currentPill}`}>{partyLabel}</span>
                        )}
                    </li>
                );
            })}
        </ol>
    );
}

export function formatQueueAge(at: Date | string | null): string {
    if (!at) return "—";
    const d = typeof at === "string" ? new Date(at) : at;
    const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60_000));
    if (mins < 60) return `${mins} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 48) return `${hours} h`;
    return `${Math.floor(hours / 24)} d`;
}

export function formatIst(at: Date | string | null | undefined): string {
    if (!at) return "—";
    const d = typeof at === "string" ? new Date(at) : at;
    if (Number.isNaN(d.getTime())) return String(at);
    return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
}

export function inr(v: number | string | null | undefined): string {
    if (v === null || v === undefined || v === "") return "—";
    const n = Number(v);
    return Number.isFinite(n) ? `₹${n.toLocaleString("en-IN")}` : String(v);
}
