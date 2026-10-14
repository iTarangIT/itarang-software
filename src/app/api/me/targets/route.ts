// /api/me/targets — the caller's own sales targets (E-303, review R-17).
//
//   GET  ?month=YYYY-MM   my targets for the month, with actual vs target —
//                         plus `next`: the following month's rows, because a
//                         CEO sets next month's targets before it starts and
//                         the rep must be able to accept them then
//   POST { ids }                         accept my sent targets (never anyone
//                                        else's — the UPDATE is scoped to me)
//   POST { action: "accept", ids }       the same
//   POST { action: "reject", ids, comment }  reject them; comment required
//   POST { action: "set_actual", id, value } my progress on a custom metric

import { z } from "zod";

import { requireAuth } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import {
    acceptTargets,
    listTargets,
    rejectTargets,
    setManualActual,
    TargetError,
    workingDayContext,
} from "@/lib/targets/service";

export const dynamic = "force-dynamic";

const MONTH = /^\d{4}-\d{2}$/;

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireAuth();
    const m = new URL(req.url).searchParams.get("month") ?? "";
    const month = MONTH.test(m) ? m : new Date().toISOString().slice(0, 7);
    const [y, mo] = month.split("-").map(Number);
    const nextMonth = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
    const [rows, context, nextRows] = await Promise.all([
        listTargets({ month, userId: user.id }),
        workingDayContext(month),
        listTargets({ month: nextMonth, userId: user.id }),
    ]);
    return successResponse({ month, rows, context, next: { month: nextMonth, rows: nextRows } });
});

const Ids = z.array(z.string().uuid()).max(100);
const BodySchema = z.union([
    z.object({ action: z.literal("accept").optional(), ids: Ids }),
    z.object({ action: z.literal("reject"), ids: Ids, comment: z.string().max(1000) }),
    z.object({ action: z.literal("set_actual"), id: z.string().uuid(), value: z.number().nullable() }),
]);

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireAuth();
    const actor = { id: user.id, role: String(user.role ?? "") };
    const body = BodySchema.parse(await req.json());
    try {
        if ("comment" in body) return successResponse(await rejectTargets(body.ids, body.comment, actor));
        if ("value" in body) return successResponse(await setManualActual(body.id, body.value, actor));
        return successResponse(await acceptTargets(body.ids, actor));
    } catch (e) {
        if (e instanceof TargetError) return errorResponse(e.message, 400);
        throw e;
    }
});
