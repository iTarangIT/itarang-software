// /api/admin/targets — the sales target register (E-303, review R-17).
//
//   GET  ?month=YYYY-MM          register + actual vs target, working-day
//                                context, the people who can be given targets,
//                                and what the caller may do
//   POST { action, ... }         add_person | update | submit | approve_push
//
// Per-action permissions live in src/lib/targets/service.ts (CEO sets, admin
// adds, admin / sales head approve) and are enforced there, not just here.

import { sql } from "drizzle-orm";
import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import {
    addPersonToMonth,
    approveAndPush,
    listTargets,
    submitTargets,
    TARGET_ADD_PERSON_ROLES,
    TARGET_ADDON_ROLES,
    TARGET_APPROVER_ROLES,
    TARGET_CEO_ROLES,
    TARGET_VIEW_ROLES,
    TargetError,
    updateTarget,
    workingDayContext,
} from "@/lib/targets/service";

export const dynamic = "force-dynamic";

const MONTH = /^\d{4}-\d{2}$/;

const BodySchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("add_person"), month: z.string().regex(MONTH), user_id: z.string().min(1).max(64) }),
    z.object({
        action: z.literal("update"),
        id: z.string().uuid(),
        ceo_target: z.number().optional(),
        admin_addon: z.number().optional(),
    }),
    z.object({ action: z.literal("submit"), ids: z.array(z.string().uuid()).max(500) }),
    z.object({ action: z.literal("approve_push"), ids: z.array(z.string().uuid()).max(500) }),
]);

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole(TARGET_VIEW_ROLES);
    const m = new URL(req.url).searchParams.get("month") ?? "";
    const month = MONTH.test(m) ? m : new Date().toISOString().slice(0, 7);
    const [rows, context, people] = await Promise.all([
        listTargets({ month }),
        workingDayContext(month),
        db.execute(sql`
            SELECT id::text AS user_id, name, role FROM users
             WHERE is_active = TRUE AND LOWER(role) IN ('asm', 'inside_sales_rep')
             ORDER BY name NULLS LAST
        `),
    ]);
    const r = (user.role ?? "").toLowerCase();
    return successResponse({
        month,
        rows,
        context,
        people,
        can: {
            add_person: TARGET_ADD_PERSON_ROLES.includes(r),
            set_ceo_target: TARGET_CEO_ROLES.includes(r),
            set_addon: TARGET_ADDON_ROLES.includes(r),
            approve: TARGET_APPROVER_ROLES.includes(r),
        },
    });
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(TARGET_VIEW_ROLES);
    const actor = { id: user.id, role: String(user.role ?? "") };
    const body = BodySchema.parse(await req.json());
    try {
        switch (body.action) {
            case "add_person":
                return successResponse(await addPersonToMonth(body.month, body.user_id, actor));
            case "update":
                await updateTarget(body.id, { ceo_target: body.ceo_target, admin_addon: body.admin_addon }, actor);
                return successResponse({ ok: true });
            case "submit":
                return successResponse(await submitTargets(body.ids, actor));
            case "approve_push":
                return successResponse(await approveAndPush(body.ids, actor));
        }
    } catch (e) {
        if (e instanceof TargetError) return errorResponse(e.message, 400);
        throw e;
    }
});
