// GET /api/admin/dashboard/alerts/[panel] — drill-down rows for one of the 11
// alert panels (BRD §0.11 Zone 3). Loaded lazily when a panel is expanded.

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import {
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";
import { fetchAlertPanel } from "@/lib/admin/dashboard";
import { parseDashboardFilters } from "@/lib/admin/filters";
import { ALERT_PANELS } from "@/lib/admin/types";

export const dynamic = "force-dynamic";

const READ_ROLES = ["admin", "sales_head", "ceo"];
const PanelSchema = z.enum(ALERT_PANELS);

export const GET = withErrorHandler(
    async (req: NextRequest, ctx: { params: Promise<{ panel: string }> }) => {
        await requireRole(READ_ROLES);
        const { panel } = await ctx.params;
        const parsed = PanelSchema.safeParse(panel);
        if (!parsed.success) return errorResponse("Unknown alert panel.", 400);

        const filters = parseDashboardFilters(new URL(req.url));
        const rows = await fetchAlertPanel(parsed.data, filters);
        return successResponse({ panel: parsed.data, rows });
    },
);
