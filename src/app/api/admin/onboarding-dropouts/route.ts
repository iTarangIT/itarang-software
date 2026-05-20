// GET /api/admin/onboarding-dropouts?page=&limit=&q=
// Converted leads whose onboarding was rejected/withdrawn or has stalled
// (BRD §0.13 Point B).

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { fetchOnboardingDropouts } from "@/lib/admin/listQueries";

export const dynamic = "force-dynamic";

const READ_ROLES = ["admin", "sales_head", "ceo"];

const QuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    q: z.string().trim().min(1).max(120).optional(),
});

export const GET = withErrorHandler(async (req: NextRequest) => {
    await requireRole(READ_ROLES);
    const url = new URL(req.url);
    const parsed = QuerySchema.parse({
        page: url.searchParams.get("page") ?? undefined,
        limit: url.searchParams.get("limit") ?? undefined,
        q: url.searchParams.get("q") ?? undefined,
    });

    const { rows, total } = await fetchOnboardingDropouts({
        page: parsed.page,
        limit: parsed.limit,
        q: parsed.q ?? null,
    });

    return successResponse({
        rows,
        total,
        page: parsed.page,
        limit: parsed.limit,
    });
});
