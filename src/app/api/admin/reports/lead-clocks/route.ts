// GET /api/admin/reports/lead-clocks?from=YYYY-MM-DD&to=YYYY-MM-DD[&spoc_id=]
// — tracker ID 86: how fast leads and new owners were first attempted and
// contacted, for clocks started in the window (lead_clocks, E-337). Median and
// the slowest 1 in 10, in working hours; the share attempted within the limit
// in force; and every "Limit passed" dated in the window. spoc_id narrows to
// one person's owner / transfer clocks.

import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { clockStats, clocksComputedAt, limitsPassed } from "@/lib/leads/clocks";

export const dynamic = "force-dynamic";

// The roles that read the Sales Head screen (as /api/admin/reports/needs-action).
const VIEW_ROLES = ["admin", "sales_head", "ceo", "partner", "business_head"];

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const Params = z.object({
    from: z.string().regex(ISO),
    to: z.string().regex(ISO),
    spoc_id: z.string().trim().min(1).max(64).optional(),
});

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(VIEW_ROLES);
    const sp = new URL(req.url).searchParams;
    const p = Params.parse({ from: sp.get("from"), to: sp.get("to"), spoc_id: sp.get("spoc_id") || undefined });
    const person = p.spoc_id ? { ownerIds: [p.spoc_id] } : {};
    const [lead, owner, transfer, passed, computedAt] = await Promise.all([
        p.spoc_id ? Promise.resolve(null) : clockStats("lead", p.from, p.to),
        clockStats("owner", p.from, p.to, person),
        clockStats("transfer", p.from, p.to, person),
        limitsPassed(p.from, p.to, person),
        clocksComputedAt(),
    ]);
    return successResponse({ available: owner !== null, computed_at: computedAt, lead, owner, transfer, limits_passed: passed });
});
