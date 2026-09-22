// /api/me/targets — the caller's own sales targets (E-303, review R-17).
//
//   GET  ?month=YYYY-MM   my targets for the month, with actual vs target —
//                         plus `next`: the following month's rows, because a
//                         CEO sets next month's targets before it starts and
//                         the rep must be able to accept them then
//   POST { ids }          accept my pushed targets (never anyone else's —
//                         acceptTargets() scopes the UPDATE to the caller)

import { z } from "zod";

import { requireAuth } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { acceptTargets, listTargets, workingDayContext } from "@/lib/targets/service";

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

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireAuth();
    const { ids } = z.object({ ids: z.array(z.string().uuid()).max(100) }).parse(await req.json());
    return successResponse(await acceptTargets(ids, { id: user.id, role: String(user.role ?? "") }));
});
