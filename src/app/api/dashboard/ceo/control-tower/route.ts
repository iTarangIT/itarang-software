// GET /api/dashboard/ceo/control-tower?<the CEO window params>
//
// Reporting Review sheet 6 — the CEO one-screen tiles, resolved against the
// same window as /api/dashboard/ceo/overview so every card on the page describes
// the same days. See src/lib/dashboard/ceoControlTower.ts.

import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { resolveWindowParams } from "@/lib/dashboard/salesWindow";
import { buildControlTower } from "@/lib/dashboard/ceoControlTower";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (req: NextRequest) => {
    await requireRole(["ceo", "admin"]);
    const resolved = resolveWindowParams(req.nextUrl.searchParams);
    if (!resolved.ok) return errorResponse(resolved.error, 400);
    const { startStr, endStr, label } = resolved.window;
    return successResponse({ label, ...(await buildControlTower({ startStr, endStr })) });
});
