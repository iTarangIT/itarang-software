/**
 * Tracker ID 85 #8 — office hours as a dated admin setting.
 *
 *   GET   the hours in force today, a change scheduled for later and the
 *         change log. Admin and CEO (the CEO reads the log, as for limits).
 *   POST  { start_hour, end_hour, working_weekdays, effective_from, note } —
 *         Admin only; appends a change to office_hours_settings (E-354).
 *         Never retroactive; a reason is required.
 */
import { z } from "zod";

import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { istDay } from "@/lib/calendar/officeCalendar";
import { DEFAULT_OFFICE_HOURS, describeOfficeHours } from "@/lib/calendar/officeHours";
import {
    OfficeHoursUnavailableError,
    getOfficeHours,
    hasOfficeHoursTable,
    officeHoursLog,
    scheduledOfficeHours,
    setOfficeHours,
} from "@/lib/calendar/officeHoursStore";

export const dynamic = "force-dynamic";

const VIEWER_ROLES = ["admin", "ceo"];
const EDITOR_ROLES = ["admin"];

const BodySchema = z.object({
    start_hour: z.number().int().min(0).max(23),
    end_hour: z.number().int().min(1).max(24),
    working_weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    note: z.string().trim().min(3, "Give a reason for the change (shown in the log).").max(500),
});

async function bundle(canEdit: boolean) {
    const today = istDay(new Date());
    const [current, scheduled, log, available] = await Promise.all([
        getOfficeHours(today),
        scheduledOfficeHours(today),
        officeHoursLog(),
        hasOfficeHoursTable(),
    ]);
    return {
        today,
        available,
        can_edit: canEdit && available,
        current: { ...current, label: describeOfficeHours(current) },
        default: { ...DEFAULT_OFFICE_HOURS, label: describeOfficeHours(DEFAULT_OFFICE_HOURS) },
        scheduled: scheduled ? { ...scheduled, label: describeOfficeHours(scheduled) } : null,
        log,
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
        await setOfficeHours({
            startHour: b.start_hour,
            endHour: b.end_hour,
            weekdays: b.working_weekdays,
            effectiveFrom: b.effective_from,
            note: b.note,
            actorId: user.id,
        });
    } catch (e) {
        if (e instanceof OfficeHoursUnavailableError) return errorResponse(e.message, 503);
        return errorResponse(e instanceof Error ? e.message : "Could not save", 400);
    }
    return successResponse(await bundle(true));
});
