// GET /api/ecofy/stage-summary — tracker ID 51 #2.
//
// Every Ecofy lead the CRM holds, by current Ecofy stage, for the small Ecofy
// block on the Sales Head and CEO dashboards. Local table only (never calls
// Ecofy). A database without ecofy_leads answers available=false, not an error.
// Managers only (Sales Head, CEO) — the same people who see the Ecofy workspace.
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { ecofyStageSummary, EMPTY_ECOFY_STAGE_SUMMARY } from "@/lib/ecofy/stageSummary";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async () => {
    await requireRole([...ECOFY_MANAGER_ROLES]);
    try {
        const probe = (await db.execute(sql`
            SELECT to_regclass('public.ecofy_leads') IS NOT NULL AS ok
        `)) as unknown as Array<{ ok: boolean }>;
        if (!probe[0]?.ok) return successResponse(EMPTY_ECOFY_STAGE_SUMMARY);
        const [rows, queue] = await Promise.all([
            db.execute(sql`SELECT e.stage, COUNT(*)::int AS n FROM ecofy_leads e GROUP BY e.stage`) as unknown as Promise<
                Array<{ stage: string | null; n: number }>
            >,
            db.execute(sql`
                SELECT COUNT(*)::int AS n FROM ecofy_leads e
                 WHERE e.stage = 'S1' AND e.assigned_to_user_id IS NULL
            `) as unknown as Promise<Array<{ n: number }>>,
        ]);
        return successResponse(ecofyStageSummary(rows, queue[0]?.n ?? 0));
    } catch (err) {
        console.warn("[ecofy/stage-summary] ecofy_leads unreadable:", err);
        return successResponse(EMPTY_ECOFY_STAGE_SUMMARY);
    }
});
