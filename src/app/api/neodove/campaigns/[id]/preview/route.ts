// POST /api/neodove/campaigns/[id]/preview
//
// Audience count + sample for a NeoDove campaign, before anything is pushed.
// Resolves through the SAME src/lib/ai-dialer/audience.ts the AI dialer uses,
// so "500 leads" here means exactly the same 500 leads it would mean there.
//
// Accepts a selection in the body (live preview while the operator adjusts
// filters) or falls back to the campaign's stored audience_filter.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import {
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";
import { resolveAudience, type AudienceSelection } from "@/lib/ai-dialer/audience";
import { NEODOVE_ADMIN_ROLES } from "@/lib/neodove/roles";

export const POST = withErrorHandler(
    async (req: Request, context: { params: Promise<{ id: string }> }) => {
        await requireRole(NEODOVE_ADMIN_ROLES);
        const { id } = await context.params;

        const rows = await db.execute<{ audience_filter: unknown }>(sql`
            SELECT audience_filter FROM neodove_campaigns WHERE id = ${id} LIMIT 1
        `);
        if (!rows[0]) return errorResponse("Campaign not found", 404);

        const body = await req.json().catch(() => ({}));
        const selection: AudienceSelection =
            body && Object.keys(body).length > 0
                ? body
                : ((rows[0].audience_filter as AudienceSelection) ?? {});

        const audience = await resolveAudience(selection);

        return successResponse({
            counts: audience.counts,
            excluded: audience.excluded,
            totalWithPhone: audience.totalWithPhone,
            total: audience.queueIds.length,
            // Sample only — the full id list is resolved server-side at push
            // time, so a stale browser tab can't push an audience the operator
            // never actually saw.
            sample: audience.queue.slice(0, 20).map((r) => ({
                id: r.id,
                phone: r.phone,
                dealer_name: r.dealer_name,
                shop_name: r.shop_name,
            })),
        });
    },
);
