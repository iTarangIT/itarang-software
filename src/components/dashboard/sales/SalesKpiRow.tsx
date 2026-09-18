"use client";

// B7 row 1 — seven KPI cards on the shared KPICard: yesterday's activity, what
// is planned, and the open hot / warm / cold counts.

import { CalendarClock, CalendarRange, Flame, MapPinned, PhoneCall, Snowflake, Sun } from "lucide-react";

import { KPICard } from "@/components/shared/kpi-card";
import type { SalesDashboardSections } from "@/lib/admin/salesDashboardTypes";

const fmt = (n: number) => n.toLocaleString("en-IN");

export function SalesKpiRow({ d, compact = false }: { d: SalesDashboardSections; compact?: boolean }) {
    const level = (l: "hot" | "warm" | "cold") =>
        d.interest.rows.find((r) => r.interest_level === l)?.total ?? 0;
    const card = compact ? "p-4 rounded-xl" : undefined;
    return (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
            <KPICard className={card} title="Visits yesterday" value={fmt(d.snapshot.visits_yesterday)} icon={MapPinned} />
            <KPICard className={card} title="Calls yesterday" value={fmt(d.snapshot.calls_yesterday)} icon={PhoneCall} />
            <KPICard className={card} title="Planned today" value={fmt(d.snapshot.planned_visits_today)} subtitle="scheduled, still open" icon={CalendarClock} />
            <KPICard className={card} title="Planned next 7 days" value={fmt(d.snapshot.planned_visits_next_7_days)} subtitle="including today" icon={CalendarRange} />
            <KPICard className={card} title="Hot" value={fmt(level("hot"))} subtitle="open leads" icon={Flame} />
            <KPICard className={card} title="Warm" value={fmt(level("warm"))} subtitle="open leads" icon={Sun} />
            <KPICard className={card} title="Cold" value={fmt(level("cold"))} subtitle="open leads" icon={Snowflake} />
        </div>
    );
}
