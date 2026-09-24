// claim_lead — take one lead from the pool (BRD §9.2, UC-05). ISR: the global
// unassigned pool; ASM: unowned AND in their territory. A pool lead has no
// owner, so claim eligibility replaces the ownership check. Gate 5.

import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { claimPoolPredicate, scopeJoin } from "../../scope";
import { defineTool, LeadId, NOT_FOUND, NOT_YET, WRITES_OFF, type ToolFactory } from "../spec";

export const claimLead: ToolFactory = () => defineTool({
    name: "claim_lead",
    kind: "write",
    description:
        "Propose claiming ONE unowned lead from the user's claim pool (ISR: unassigned pool; ASM: unclaimed in their territory). " +
        "Nothing is saved until Confirm.",
    schema: z.object({ lead_id: LeadId }),
    run: async (ctx, input) => {
        if (!ctx.writesEnabled) return WRITES_OFF;
        const rows = await db.execute<{ id: string }>(sql`
            SELECT dl.id FROM dealer_leads dl ${scopeJoin(ctx.user)}
             WHERE dl.id = ${input.lead_id.trim()} AND ${claimPoolPredicate(ctx.user)}
             LIMIT 1
        `);
        return rows.length === 0 ? NOT_FOUND : NOT_YET;
    },
});
