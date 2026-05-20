"use client";

// BRD §0.11 Zone 1 — the KPI strip. 8 metric tiles + the logging-compliance
// tile, rendered as StatCards with a staggered mount. Exception metrics
// (escalations, dropouts, stale, compliance) tint when non-zero.

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
    if (h < 1) return `${Math.round(h * 60)}m`;
    return `${h.toFixed(1)}h`;
}
function fmtPct(r: number | null): string {
    if (r == null) return "—";
    return `${Math.round(r * 100)}%`;
}

export function KpiStrip({ kpis }: { kpis: AdminKpis }) {
    const flag = (n: number, tone: StatTone): StatTone => (n > 0 ? tone : "neutral");

    const tiles: {
        label: string;
        value: string | number;
        icon: React.ComponentType<{ className?: string }>;
        tone: StatTone;
        hint?: string;
    }[] = [
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
        {
            label: "Conversion Rate · 7d",
            value: fmtPct(kpis.conversion_rate_7d),
            icon: TrendingUp,
            tone: "neutral",
        },
        {
            label: "Conversion Rate · 30d",
            value: fmtPct(kpis.conversion_rate_30d),
            icon: TrendingUp,
            tone: "neutral",
        },
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
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {tiles.map((t, i) => (
                <StatCard
                    key={t.label}
                    index={i}
                    label={t.label}
                    value={t.value}
                    icon={t.icon}
                    tone={t.tone}
                    hint={t.hint}
                />
            ))}
        </div>
    );
}
