// Small shared bits for the escalation surfaces.

export function humanize(s: string | null | undefined): string {
    if (!s) return "—";
    return s.replace(/_/g, " ");
}

export function UrgencyChip({ urgency }: { urgency: string }) {
    const map: Record<string, string> = {
        urgent: "bg-danger-bg text-danger border-danger/30",
        high: "bg-warning-bg text-warning border-warning/30",
        normal: "bg-bg text-ink-muted border-border",
    };
    const cls = map[urgency] ?? map.normal;
    return (
        <span
            className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide border ${cls}`}
        >
            {urgency}
        </span>
    );
}
