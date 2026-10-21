// GET /api/admin/reports/lead-clocks?from=YYYY-MM-DD&to=YYYY-MM-DD[&spoc_id=]
// — tracker ID 86: how fast leads and new owners were first attempted and
// contacted, for clocks started in the window (lead_clocks, E-337). Median and
// the slowest 1 in 10, in working hours; the share attempted within the limit
// in force; and every "Limit passed" dated in the window. spoc_id narrows to
// one person's owner / transfer clocks. by_owner (18 Oct row 28) is one row
// per owner for the owner clock: median, slowest 1 in 10, % within limit and
// limits passed. include_guessed=1 (a manager's switch, 18 Oct #7) also counts
// the clocks charged to a guessed owner (before 10 Sep 2026).

import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { clockStats, clockStatsByOwner, clocksComputedAt, limitsPassed } from "@/lib/leads/clocks";
import { getOfficeHours } from "@/lib/calendar/officeHoursStore";
import { shortOfficeHours } from "@/lib/calendar/officeHours";

export const dynamic = "force-dynamic";

// The roles that read the Sales Head screen (as /api/admin/reports/needs-action).
const VIEW_ROLES = ["admin", "sales_head", "ceo", "partner", "business_head"];

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const Params = z.object({
    from: z.string().regex(ISO),
    to: z.string().regex(ISO),
    spoc_id: z.string().trim().min(1).max(64).optional(),
    include_guessed: z.boolean(),
});

export const GET = withErrorHandler(async (req: Request) => {
    await requireRole(VIEW_ROLES);
    const sp = new URL(req.url).searchParams;
    const p = Params.parse({
        from: sp.get("from"),
        to: sp.get("to"),
        spoc_id: sp.get("spoc_id") || undefined,
        include_guessed: sp.get("include_guessed") === "1",
    });
    const person = p.spoc_id ? { ownerIds: [p.spoc_id], includeGuessed: p.include_guessed } : {};
    const [lead, owner, transfer, passed, computedAt, byOwner, hours] = await Promise.all([
        p.spoc_id ? Promise.resolve(null) : clockStats("lead", p.from, p.to),
        clockStats("owner", p.from, p.to, person),
        clockStats("transfer", p.from, p.to, person),
        limitsPassed(p.from, p.to, person),
        clocksComputedAt(),
        clockStatsByOwner("owner", p.from, p.to, { includeGuessed: p.include_guessed }),
        getOfficeHours(),
    ]);
    return successResponse({
        available: owner !== null,
        computed_at: computedAt,
        lead,
        owner,
        transfer,
        limits_passed: passed,
        by_owner: p.spoc_id ? byOwner.filter((r) => r.owner_id === p.spoc_id) : byOwner,
        include_guessed: p.include_guessed,
        office_hours: shortOfficeHours(hours),
    });
});
