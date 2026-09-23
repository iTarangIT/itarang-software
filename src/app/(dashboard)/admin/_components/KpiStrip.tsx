"use client";

// BRD §0.11 Zone 1 — the KPI strip. Three visually grouped tiers:
//   • Activity: 3 throughput metrics
//   • Conversion: the four conversion measures (review R-08) — five tiles,
//     closed-win has 7d and 30d. Each tile's hint says exactly what it divides
//     by; "Conversion Rate" with no qualifier is what R-08 was about.
//   • Exceptions: 4 alert metrics that tint when non-zero (4-col grid)

import {
    Activity,
    AlertTriangle,
    CalendarClock,
    Inbox,
    ShieldAlert,
    Timer,
    TrendingUp,
    UserMinus,
} from "lucide-react";
import { StatCard, type StatTone } from "@/components/ui/stat-card";
import type { AdminKpis } from "@/lib/admin/types";

function fmtHours(h: number | null): string {
    if (h == null) return "—";
    // Defensive: pre-assignment touchpoints used to leak a negative value here
    // (fixed at the SQL layer). Clamp at zero so any future regression renders
    // a harmless "0m" rather than a confusing "-238m".
    const v = h < 0 ? 0 : h;
    if (v < 1) return `${Math.round(v * 60)}m`;
    return `${v.toFixed(1)}h`;
}
function fmtPct(r: number | null): string {
    if (r == null) return "—";
    return `${Math.round(r * 100)}%`;
}

type Tile = {
    label: string;
    value: string | number;
    icon: React.ComponentType<{ className?: string }>;
    tone: StatTone;
    hint?: string;
};

export function KpiStrip({ kpis }: { kpis: AdminKpis }) {
    const flag = (n: number, tone: StatTone): StatTone =>
        n > 0 ? tone : "neutral";

    const activity: Tile[] = [
        {
            label: "Unassigned Queue",
            value: kpis.unassigned_queue,
            icon: Inbox,
            tone: "neutral",
        },
        {
            label: "Avg Time to First Touch",
            value: fmtHours(kpis.avg_time_to_first_touch_hours),
            icon: Timer,
            tone: "neutral",
            hint: "leads assigned · last 7 days",
        },
        {
            label: "Leads Worked Today",
            value: kpis.leads_worked_today,
            icon: Activity,
            tone: "neutral",
        },
    ];

    const conversion: Tile[] = [
        {
            label: "Lead Conversion · to date",
            value: fmtPct(kpis.cohort_conversion_to_date),
            icon: TrendingUp,
            tone: "neutral",
            hint: "leads created last 30 days · converted so far",
        },
        {
            label: "30-Day Lead Conversion",
            value: fmtPct(kpis.conversion_30d_rate),
            icon: TrendingUp,
            tone: "neutral",
            hint: "leads created 31–60 days ago · converted within 30 days",
        },
        {
            label: "Engaged → Converted",
            value: fmtPct(kpis.engaged_to_conversion_rate),
            icon: TrendingUp,
            tone: "neutral",
            hint: "leads created last 30 days with a connected call or productive visit",
        },
        {
            label: "Closed-Win · 7d",
            value: fmtPct(kpis.closed_win_rate_7d),
            icon: TrendingUp,
            tone: "neutral",
            hint: "converted ÷ (converted + lost) · closed last 7 days",
        },
        {
            label: "Closed-Win · 30d",
            value: fmtPct(kpis.closed_win_rate_30d),
            icon: TrendingUp,
            tone: "neutral",
            hint: "converted ÷ (converted + lost) · closed last 30 days",
        },
    ];

    const exceptions: Tile[] = [
        {
            label: "Pending Escalations",
            value: kpis.pending_escalations,
            icon: AlertTriangle,
            tone: flag(kpis.pending_escalations, "warning"),
        },
        {
            label: "Onboarding Dropouts",
            value: kpis.onboarding_dropouts_pending,
            icon: UserMinus,
            tone: flag(kpis.onboarding_dropouts_pending, "warning"),
        },
        {
            label: "Stale Converted · 3d+",
            value: kpis.stale_converted,
            icon: CalendarClock,
            tone: flag(kpis.stale_converted, "warning"),
        },
        {
            label: "Status Changes w/o Touchpoint",
            value: kpis.compliance_status_without_touchpoint,
            icon: ShieldAlert,
            tone: flag(kpis.compliance_status_without_touchpoint, "danger"),
            hint: "logging compliance · last 30 days",
        },
    ];

    return (
        <div className="space-y-5">
            <KpiSection
                title="Activity"
                tiles={activity}
                cols="lg:grid-cols-3"
                offset={0}
            />
            <KpiSection
                title="Conversion"
                tiles={conversion}
                cols="lg:grid-cols-3 xl:grid-cols-5"
                offset={activity.length}
            />
            <KpiSection
                title="Exceptions"
                tiles={exceptions}
                cols="lg:grid-cols-2 xl:grid-cols-4"
                offset={activity.length + conversion.length}
            />
        </div>
    );
}

function KpiSection({
    title,
    tiles,
    cols,
    offset,
}: {
    title: string;
    tiles: Tile[];
    cols: string;
    offset: number;
}) {
    return (
        <section>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                {title}
            </h2>
            <div className={`grid grid-cols-2 gap-3 sm:grid-cols-3 ${cols}`}>
                {tiles.map((t, i) => (
                    <StatCard
                        key={t.label}
                        index={offset + i}
                        label={t.label}
                        value={t.value}
                        icon={t.icon}
                        tone={t.tone}
                        hint={t.hint}
                    />
                ))}
            </div>
        </section>
    );
}
