// Module 3 — parse the shared dashboard/report filter set (BRD §0.11 Zone 4)
// out of a request URL. Reused by the dashboard, alert-panel, and report routes.

import type { DashboardFilters } from "./types";

export function parseDashboardFilters(url: URL): DashboardFilters {
    const p = url.searchParams;
    const str = (k: string): string | null => {
        const v = p.get(k)?.trim();
        return v ? v : null;
    };
    return {
        date_from: str("date_from"),
        date_to: str("date_to"),
        owner_id: str("owner_id"),
        status: str("status"),
        source: str("source"),
        segment: str("segment"),
        city: str("city"),
        state: str("state"),
        follow_up_due_today: p.get("follow_up_due_today") === "true",
        reactivated_only: p.get("reactivated_only") === "true",
    };
}
