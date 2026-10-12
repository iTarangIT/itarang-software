/**
 * Tracker ID 85 — time limits as dated admin settings.
 *
 *   GET   the limits in force today, any change scheduled for later, the
 *         change log and the office calendar's holidays. Admin and CEO (the
 *         CEO sees the log, decided 10 Oct).
 *   POST  { key, value, effective_from, note } — Admin only; appends a change
 *         to time_limit_settings (E-337). Never retroactive.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { istDay } from "@/lib/calendar/officeCalendar";
import { TIME_LIMITS } from "@/lib/timeLimits/registry";
import {
    TimeLimitsUnavailableError,
    getTimeLimits,
    hasTimeLimitTable,
    scheduledChanges,
    setTimeLimit,
    timeLimitLog,
} from "@/lib/timeLimits/store";

export const dynamic = "force-dynamic";

const VIEWER_ROLES = ["admin", "ceo"];
const EDITOR_ROLES = ["admin"];

const BodySchema = z.object({
    key: z.string().min(1).max(60),
    value: z.number().int(),
    effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    note: z.string().trim().max(500).optional().nullable(),
});

async function bundle(canEdit: boolean) {
    const today = istDay(new Date());
    const [values, scheduled, log, available, holidays] = await Promise.all([
        getTimeLimits(today),
        scheduledChanges(today),
        timeLimitLog(),
        hasTimeLimitTable(),
        db.execute(sql`
            SELECT holiday_id, holiday_date::text AS holiday_date, holiday_name, is_active
              FROM holiday_calendar ORDER BY holiday_date DESC LIMIT 200`),
    ]);
    return {
        today,
        available,
        can_edit: canEdit && available,
        limits: TIME_LIMITS.map((d) => ({ ...d, value: values[d.key], scheduled: scheduled[d.key] ?? null })),
        log,
        holidays,
    };
}

export const GET = withErrorHandler(async () => {
    const user = await requireRole(VIEWER_ROLES);
    return successResponse(await bundle(EDITOR_ROLES.includes(user.role)));
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(EDITOR_ROLES);
    const b = BodySchema.parse(await req.json());
    try {
        await setTimeLimit({ key: b.key, value: b.value, effectiveFrom: b.effective_from, note: b.note || null, actorId: user.id });
    } catch (e) {
        if (e instanceof TimeLimitsUnavailableError) return errorResponse(e.message, 503);
        return errorResponse(e instanceof Error ? e.message : "Could not save", 400);
    }
    return successResponse(await bundle(true));
});
