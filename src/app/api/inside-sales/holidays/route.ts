// GET /api/inside-sales/holidays
// Returns the active holiday_calendar dates as ISO strings. Used client-side
// for stale-lead working-day cues (BRD §0.5). Cached at the edge for 1 hour.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";

const READ_ROLES = [
    "inside_sales_rep",
    "asm",
    "admin",
    "ceo",
    "sales_manager",
    "sales_head",
    "business_head",
];

export const GET = withErrorHandler(async () => {
    await requireRole(READ_ROLES);
    const rows = await db.execute<{ holiday_date: string }>(sql`
        SELECT holiday_date::text AS holiday_date FROM holiday_calendar WHERE is_active = TRUE
    `);
    return successResponse({ dates: rows.map((r) => r.holiday_date) });
});
