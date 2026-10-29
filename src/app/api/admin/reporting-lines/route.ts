// Tracker ID 155 — reporting lines (users.reports_to, E-335; history, E-338).
//
// GET   /api/admin/reporting-lines              → every staff login with whom they report to
// GET   /api/admin/reporting-lines?user_id=X    → that person's dated history (E-338)
// PATCH /api/admin/reporting-lines  { user_id, reports_to | null, effective_from?, reason? }
//
// ID 155 decision (8 Oct): Sales Head and Admin change it. The CEO can still
// read the screen but no longer save — every other Admin › Settings write
// route is ["admin", "sales_head"], so this one now matches them. Refuses a
// person reporting to themselves and any loop (src/lib/users/reportingCycle.ts),
// and a start date in the future or before the current line began. Each change
// closes the open history line, opens the new one, keeps users.reports_to in
// sync and writes an audit_logs row (src/lib/users/reportingLines.ts).
//
// A manager's team (direct reports) widens what they read and reassign — see
// src/lib/users/team.ts.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import {
    hasReportingHistoryTable,
    hasReportsToColumn,
    listReportingHistory,
    listReportingLines,
    setReportsTo,
} from "@/lib/users/reportingLines";

export const dynamic = "force-dynamic";

const READ_ROLES = ["admin", "ceo", "sales_head"];
/** ID 155: who may change a reporting line. */
const WRITE_ROLES = ["admin", "sales_head"];
/** 29 Oct: only the Sales Head takes someone out of a team (reports_to -> nobody). */
const REMOVE_ROLES = ["sales_head"];

const BodySchema = z.object({
    user_id: z.string().uuid(),
    reports_to: z.string().uuid().nullable(),
    effective_from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .optional(),
    reason: z.string().max(500).nullable().optional(),
});

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole(READ_ROLES);
    const userId = new URL(req.url).searchParams.get("user_id");
    if (userId) {
        if (!z.string().uuid().safeParse(userId).success) return errorResponse("Bad user_id.", 400);
        const [history, historyAvailable] = await Promise.all([listReportingHistory(userId), hasReportingHistoryTable()]);
        return successResponse({ history, history_available: historyAvailable });
    }
    const [rows, available, historyAvailable] = await Promise.all([
        listReportingLines(),
        hasReportsToColumn(),
        hasReportingHistoryTable(),
    ]);
    return successResponse({
        rows,
        available,
        history_available: historyAvailable,
        can_edit: WRITE_ROLES.includes(user.role),
        can_remove: REMOVE_ROLES.includes(user.role),
    });
});

export const PATCH = withErrorHandler(async (req: Request) => {
    const user = await requireRole(WRITE_ROLES);
    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
        return errorResponse("Send user_id, reports_to (a user id, or null to clear) and optionally effective_from (YYYY-MM-DD).", 400);
    }
    const { user_id, reports_to, effective_from, reason } = parsed.data;
    if (reports_to === null && !REMOVE_ROLES.includes(user.role)) {
        return errorResponse("Only the Sales Head can remove someone from a team. You can move them to another manager.", 403);
    }
    const res = await setReportsTo(user_id, reports_to, {
        changedBy: user.id,
        effectiveFrom: effective_from ?? null,
        reason: reason ?? null,
    });
    if (!res.ok) return errorResponse(res.message, res.status);
    return successResponse({ ok: true, unchanged: res.unchanged ?? false });
});
