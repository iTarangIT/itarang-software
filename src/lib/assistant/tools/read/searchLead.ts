// search_lead — find leads the user can see by dealer name, shop or phone
// (BRD §9.1, UC-08). The queue's own search clause (leadSearchClause) under the
// user's scope predicate: a rep finds here exactly what their tabs' search box
// would find across all their tabs, and nothing else. Several matches come back
// as candidates for the user to pick from — the tool never picks one.

import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { leadSearchClause } from "@/lib/leads/queueFilterSql";
import { MAX_TOOL_ROWS, type ToolResult } from "../../types";
import { scopeJoin, scopePredicate } from "../../scope";
import { defineTool, type ToolFactory } from "../spec";
import { queueUrl, toLeadSummary } from "../leads";

/**
 * "98123 45678", "+91-98123-45678" → "9812345678": a phone typed with spaces or
 * a country code would never match the stored number as a substring. Anything
 * that isn't phone-shaped is searched as typed.
 */
export function normalizeSearch(query: string): string {
    const q = query.trim();
    if (/^[\d\s+\-().]{8,}$/.test(q)) {
        const digits = q.replace(/\D/g, "");
        return digits.length > 10 ? digits.slice(-10) : digits;
    }
    return q;
}

export const searchLead: ToolFactory = () =>
    defineTool({
        name: "search_lead",
        kind: "read",
        description:
            "Find leads the user can see by dealer name, shop name or phone number (max 10). " +
            "If more than one lead matches, show the candidates and ask which one — never pick one yourself.",
        schema: z.object({
            query: z.string().trim().min(2).max(60).describe("Name, shop or phone digits, as the user wrote them"),
        }),
        run: async (ctx, input): Promise<ToolResult> => {
            const q = normalizeSearch(input.query);
            const nextCol = ctx.user.role === "asm" ? sql`lv.scheduled_date::text` : sql`dl.next_follow_up_at`;
            const rows = await db.execute<{
                id: string;
                shop_name: string | null;
                dealer_name: string | null;
                city: string | null;
                lead_status: string | null;
                interest_level: string | null;
                current_owner_id: string | null;
                current_owner_name: string | null;
                next_date: unknown;
                total: number;
            }>(sql`
                SELECT dl.id, dl.shop_name, dl.dealer_name, dl.city, dl.lead_status, dl.interest_level,
                       dl.current_owner_id, owner.name AS current_owner_name,
                       ${nextCol} AS next_date,
                       count(*) OVER ()::int AS total
                  FROM dealer_leads dl
                  ${scopeJoin(ctx.user)}
                  LEFT JOIN users owner ON owner.id::text = dl.current_owner_id
                 WHERE ${scopePredicate(ctx.user)} ${leadSearchClause(q)}
                 ORDER BY COALESCE(dl.last_touchpoint_at, dl.assigned_at, dl.created_at) DESC NULLS LAST
                 LIMIT ${MAX_TOOL_ROWS}
            `);
            const summaries = rows.map((r) =>
                toLeadSummary(
                    ctx.user.role === "asm"
                        ? { ...r, scheduled_date: r.next_date }
                        : { ...r, next_follow_up_at: r.next_date },
                    ctx.user,
                ),
            );
            const total = rows[0]?.total ?? 0;
            if (summaries.length > 1) {
                return {
                    kind: "candidates",
                    question: `${total} leads match "${input.query}". Which one do you mean?`,
                    rows: summaries,
                };
            }
            return { kind: "leads", title: `Search: "${input.query}"`, rows: summaries, total, crm_url: queueUrl(ctx.user) };
        },
    });
