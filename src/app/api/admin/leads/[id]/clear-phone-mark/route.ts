// POST /api/admin/leads/[id]/clear-phone-mark
// ID 207 (28 Oct): a switchboard or dead-number mark blocks the number in every
// campaign until the phone changes. Admin clears it here; the next campaign
// dials the number again. Every lead on the same number is cleared (the block
// matches on the number), and the change goes in audit_logs.

import { sql } from "drizzle-orm";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { clearObservedMark, observedMarkOf } from "@/lib/ai-dialer/phoneTypeStore";

export const POST = withErrorHandler(
    async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(["admin"]);
        const { id } = await ctx.params;

        const mark = await observedMarkOf(id);
        if (!mark) return errorResponse("This lead's number has no switchboard or dead-number mark.", 404);

        const { cleared, key } = await clearObservedMark(id);

        await db
            .execute(sql`
                INSERT INTO audit_logs (id, entity_type, entity_id, action, changes, performed_by)
                VALUES (${`AUDIT-PHONEMARK-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}, 'lead', ${id},
                        'phone_mark_cleared', ${JSON.stringify({ mark, number_key: key, rows_cleared: cleared })}::jsonb,
                        ${user.id}::uuid)`)
            .catch((e) =>
                console.warn("[clear-phone-mark] audit log not written:", e instanceof Error ? e.message : e),
            );

        return successResponse({ ok: true, mark, cleared });
    },
);
