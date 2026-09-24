// Small presentational pieces shared by the Ecofy Leads list and detail pages.

const STAGE_LABELS: Record<string, string> = {
    S0: "Returned to Ecofy",
    CLOSED: "Closed",
};

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

export function StageBadge({ value }: { value: string | null }) {
    if (!value) return <span className="text-gray-400">—</span>;
    const label = STAGE_LABELS[value];
    return (
        <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
            {label ? `${value} · ${label}` : value}
        </span>
    );
}

export function formatQueueAge(at: Date | null): string {
    if (!at) return "—";
    const mins = Math.max(0, Math.floor((Date.now() - at.getTime()) / 60_000));
    if (mins < 60) return `${mins} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 48) return `${hours} h`;
    return `${Math.floor(hours / 24)} d`;
}

export function formatIst(at: Date | null): string {
    if (!at) return "—";
    return at.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "medium",
        timeStyle: "short",
    });
}
