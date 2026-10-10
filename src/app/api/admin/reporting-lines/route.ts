// Tracker ID 155 — reporting lines (users.reports_to, E-335).
//
// GET   /api/admin/reporting-lines  → every staff login with whom they report to
// PATCH /api/admin/reporting-lines  { user_id, reports_to | null } → set / clear
//
// Admin, CEO and Sales Head only. Refuses a person reporting to themselves and
// any loop (src/lib/users/reportingCycle.ts). Stored and shown only — no
// visibility or scoping rule reads these lines yet.

import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { hasReportsToColumn, listReportingLines, setReportsTo } from "@/lib/users/reportingLines";

export const dynamic = "force-dynamic";

const ROLES = ["admin", "ceo", "sales_head"];

const BodySchema = z.object({
    user_id: z.string().uuid(),
    reports_to: z.string().uuid().nullable(),
});

export const GET = withErrorHandler(async () => {
    await requireRole(ROLES);
    const [rows, available] = await Promise.all([listReportingLines(), hasReportsToColumn()]);
    return successResponse({ rows, available });
});

export const PATCH = withErrorHandler(async (req: Request) => {
    await requireRole(ROLES);
    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return errorResponse("Send user_id and reports_to (a user id, or null to clear).", 400);
    const { user_id, reports_to } = parsed.data;
    const res = await setReportsTo(user_id, reports_to);
    if (!res.ok) return errorResponse(res.message, res.status);
    return successResponse({ ok: true });
});
