// GET /api/admin/dashboard — Admin Dashboard data (BRD §0.11).
// Returns KPI strip, team-performance table, and the 11 alert-panel counts in
// one call. Filters (Zone 4) come from the query string.

import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import {
    fetchAlertCounts,
    fetchKpis,
    fetchTeamPerformance,
} from "@/lib/admin/dashboard";
import { parseDashboardFilters } from "@/lib/admin/filters";
import type { DashboardResponse } from "@/lib/admin/types";

export const dynamic = "force-dynamic";

// BRD §0.12 — admin gets the full dashboard; CEO gets it read-only.
const READ_ROLES = ["admin", "sales_head", "ceo"];

export const GET = withErrorHandler(async (req: NextRequest) => {
    await requireRole(READ_ROLES);
    const filters = parseDashboardFilters(new URL(req.url));

    const [kpis, team, alert_counts] = await Promise.all([
        fetchKpis(filters),
        fetchTeamPerformance(filters),
        fetchAlertCounts(filters),
    ]);

    const body: DashboardResponse = { kpis, team, alert_counts };
    return successResponse(body);
});
