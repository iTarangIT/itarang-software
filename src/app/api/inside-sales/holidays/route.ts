// GET /api/inside-sales/holidays
// Returns the active holiday_calendar dates as ISO strings, plus the no-touch
// cue thresholds in force today (ID 85 time limits). Used client-side for
// stale-lead working-day cues (BRD §0.5). Cached at the edge for 1 hour.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { getTimeLimits } from "@/lib/timeLimits/store";

const READ_ROLES = [
    "inside_sales_rep",
    "asm",
    "admin",
    "ceo",
    "sales_manager",
    "sales_head",
    "business_head",
    "partner",
];

export const GET = withErrorHandler(async () => {
    await requireRole(READ_ROLES);
    const [rows, limits] = await Promise.all([
        db.execute<{ holiday_date: string }>(sql`
            SELECT holiday_date::text AS holiday_date FROM holiday_calendar WHERE is_active = TRUE
        `),
        getTimeLimits(),
    ]);
    return successResponse({
        dates: rows.map((r) => r.holiday_date),
        stale_thresholds: {
            yellow: limits.stale_yellow,
            red: limits.stale_red,
            critical: limits.stale_critical,
        },
    });
});
