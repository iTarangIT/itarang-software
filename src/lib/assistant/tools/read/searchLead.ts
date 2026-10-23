// search_lead — find the user's OWN leads by dealer name, shop or phone
// (BRD §9.1, UC-08). The queue's own search clause (leadSearchClause) under the
// user's OWN-tabs predicate (ID 45: reps cannot browse the pool): a rep finds
// here what their own tabs' search box would find, and nothing else. Several matches come back
// as candidates for the user to pick from — the tool never picks one.

import { z } from "zod";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { leadSearchClause } from "@/lib/leads/queueFilterSql";
import { MAX_TOOL_ROWS, PAGE_MAX, pageOffset, pagingArgs, type ToolResult } from "../../types";
import { ownScopePredicate, scopeJoin, scopeTeam } from "../../scope";
import { defineTool, type ToolFactory } from "../spec";
import { queueUrl, toLeadSummary } from "../leads";

/**
 * "98123 45678", "+91-98123-45678", "098123 45678" → "9812345678": a phone
 * typed with spaces, a country code or a trunk 0 would never match the stored
 * number as a substring. A leading 91 (country code) / 0 is dropped only while
 * more than 7 digits remain (a short partial number stays as typed). Anything that isn't
 * phone-shaped is searched as typed.
 */
export function normalizeSearch(query: string): string {
    const q = query.trim();
    if (/^[\d\s+\-().]{8,}$/.test(q)) {
        let digits = q.replace(/\D/g, "");
        // 91 is a country code when written as one (+91 / 0091) or when it makes
        // the number longer than 10 digits — a 10-digit mobile may start with 91.
        const code = /^(\+|00)\s*91/.test(q) || digits.length > 10;
        if (code && digits.startsWith("0091")) digits = digits.slice(2);
        if (code && digits.startsWith("91") && digits.length - 2 > 7) digits = digits.slice(2);
        if (digits.startsWith("0") && digits.length - 1 > 7) digits = digits.slice(1);
        return digits.length > 10 ? digits.slice(-10) : digits;
    }
    return q;
}

/**
 * The queue's own search clause (leadSearchClause, shared with the screens and
 * left as it is), plus — for an all-digit query — the stored phone compared
 * digits-only, so "9812345678" finds a lead saved as "+91 98123-45678".
 * `TRUE AND (…) OR (…)` reads as `(TRUE AND (…)) OR (…)`: the screens' clause
 * reused verbatim, never restated.
 */
export function assistantSearchClause(q: string): SQL {
    if (!/^\d+$/.test(q)) return leadSearchClause(q);
    return sql` AND (TRUE ${leadSearchClause(q)} OR regexp_replace(COALESCE(dl.phone, ''), '[^0-9]', '', 'g') LIKE ${`%${q}%`})`;
}

export const searchLead: ToolFactory = () =>
    defineTool({
        name: "search_lead",
        kind: "read",
        description:
            "Find the user's OWN leads (their own queue tabs, not the unowned pool) by dealer name, shop name or phone number (10 per page; page 2 = the next 10). " +
            "If more than one lead matches, show the candidates and ask which one — never pick one yourself.",
        schema: z.object({
            query: z.string().trim().min(2).max(60).describe("Name, shop or phone digits, as the user wrote them"),
            page: z.number().int().min(1).max(PAGE_MAX).optional().describe("Page of 10, default 1"),
        }),
        run: async (ctx, input): Promise<ToolResult> => {
            const q = normalizeSearch(input.query);
            // ID 155: a manager searches the team's leads too, as on the screen.
            const team = await scopeTeam(ctx.user);
            // What the rep acts on next — toLeadSummary keeps an ASM's latest
            // visit date only while that visit is still open (visit_status).
            const nextCols =
                ctx.user.role === "asm"
                    ? sql`lv.scheduled_date::text AS next_date, lv.visit_status`
                    : sql`dl.next_follow_up_at AS next_date, NULL::text AS visit_status`;
            const rows = await db.execute<{
                id: string;
                shop_name: string | null;
                dealer_name: string | null;
                city: string | null;
                phone: string | null;
                last_touchpoint_at: unknown;
                lead_status: string | null;
                interest_level: string | null;
                current_owner_id: string | null;
                current_owner_name: string | null;
                next_date: unknown;
                visit_status: string | null;
                total: number;
            }>(sql`
                SELECT dl.id, dl.shop_name, dl.dealer_name, dl.city, dl.phone, dl.last_touchpoint_at,
                       dl.lead_status, dl.interest_level,
                       dl.current_owner_id, owner.name AS current_owner_name,
                       ${nextCols},
                       count(*) OVER ()::int AS total
                  FROM dealer_leads dl
                  ${scopeJoin(ctx.user)}
                  LEFT JOIN users owner ON owner.id::text = dl.current_owner_id
                 WHERE ${ownScopePredicate(ctx.user, team)} ${assistantSearchClause(q)}
                 ORDER BY COALESCE(dl.last_touchpoint_at, dl.assigned_at, dl.created_at) DESC NULLS LAST
                 LIMIT ${MAX_TOOL_ROWS} OFFSET ${pageOffset(input.page)}
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
            const paging = { page: input.page ?? 1, page_size: MAX_TOOL_ROWS, args: pagingArgs(input) };
            if (summaries.length > 1) {
                return {
                    kind: "candidates",
                    question: `${total} leads match "${input.query}". Which one do you mean?`,
                    rows: summaries,
                    total,
                    crm_url: queueUrl(ctx.user),
                    paging,
                };
            }
            return { kind: "leads", title: `Search: "${input.query}"`, rows: summaries, total, crm_url: queueUrl(ctx.user), paging };
        },
    });
