// my_queue — list one of the user's own queue tabs, exactly as the screen does
// (BRD §9.1). Calls the SAME builders as /api/inside-sales/queue and
// /api/asm/queue, with the SAME defaults those routes derive from an empty
// query string — so row N here is row N on the screen.

import { z } from "zod";
import { TAB_LABELS, type QueueTab } from "@/lib/inside-sales/types";
import { ASM_TAB_LABELS, type AsmQueueTab } from "@/lib/asm/types";
import { countQueueRows, fetchQueueRows } from "@/lib/inside-sales/queryBuilder";
import { countAsmQueueRows, fetchAsmQueueRows } from "@/lib/asm/queryBuilder";
import { readQueueFilters } from "@/lib/leads/queueFilters";
import { readQueueSort } from "@/lib/leads/queueSort";
import { readAsmQueueFilters } from "@/lib/asm/queueFilterParams";
import { teamForOwnScopedViewer } from "@/lib/users/team";
import { MAX_TOOL_ROWS, PAGE_MAX, pageOffset, pagingArgs, type AssistantUser, type ToolResult } from "../../types";
import { defineTool, type ToolFactory } from "../spec";
import { queueUrl, toLeadSummary } from "../leads";
import { ASM_OWN_TABS, ISR_OWN_TABS } from "../../scope";

/**
 * The screen's own defaults: what its route reads from `?` with no params —
 * plus, when asked, the screen's own Interest filter (`?interest=hot`).
 */
const screenParams = (interest?: string | null) =>
    new URLSearchParams(interest ? { interest } : {});

/**
 * The queue screens' page size (AsmQueueView / the ISR queue both ask for 25).
 * Fetched at THAT size and cut to 10, never fetched at 10: several tabs order by
 * columns with heavy ties (unassigned / unclaimed / territory sort on
 * final_intent_score, created_at — sandbox has groups of 100 leads identical on
 * both), so Postgres may break ties differently for LIMIT 10 than for LIMIT 25.
 * Running the screen's exact query is what makes row N here row N there.
 */
export const SCREEN_PAGE_SIZE = 25;

/**
 * Rows offset … offset+MAX_TOOL_ROWS-1 read off the screen's own pages of 25
 * (one or two of them) — page 3 of the Assistant is rows 21–30, which spans
 * screen pages 1 and 2. Never a query at another size (see above). Pure
 * over `fetchPage`.
 */
export async function sliceScreenPages<T>(offset: number, fetchPage: (page: number) => Promise<T[]>): Promise<T[]> {
    const first = Math.floor(offset / SCREEN_PAGE_SIZE) + 1;
    const last = Math.floor((offset + MAX_TOOL_ROWS - 1) / SCREEN_PAGE_SIZE) + 1;
    const pages = await Promise.all(Array.from({ length: last - first + 1 }, (_, i) => fetchPage(first + i)));
    const start = offset - (first - 1) * SCREEN_PAGE_SIZE;
    return pages.flat().slice(start, start + MAX_TOOL_ROWS);
}

/** Exported so the Gate 3 equality check calls the builders the same way. */
export async function queueRowsForTool(
    user: AssistantUser,
    tab: string,
    search?: string | null,
    interest?: string | null,
    page?: number | null,
) {
    const offset = pageOffset(page);
    const q = search?.trim() || null;
    const params = screenParams(interest);
    // ID 155: a manager's own tabs cover the team, exactly as the queue routes
    // (and their badge counts) widen them — empty for everyone else.
    const teamMemberIds = await teamForOwnScopedViewer(user);
    if (user.role === "asm") {
        const { filters, sort, visitStatus, visitOutcome } = readAsmQueueFilters(params);
        const args = { tab: tab as AsmQueueTab, asmId: user.id, q, filters, visitStatus, visitOutcome, teamMemberIds };
        const [rows, total] = await Promise.all([
            sliceScreenPages(offset, (p) => fetchAsmQueueRows({ ...args, page: p, limit: SCREEN_PAGE_SIZE, sort })),
            countAsmQueueRows(args),
        ]);
        return { rows, total };
    }
    const filters = readQueueFilters(params);
    const sort = readQueueSort(params);
    const args = { tab: tab as QueueTab, userId: user.id, q, filters, neodoveOnly: false, callbackOnly: false, teamMemberIds };
    const [rows, total] = await Promise.all([
        sliceScreenPages(offset, (p) => fetchQueueRows({ ...args, page: p, limit: SCREEN_PAGE_SIZE, sort })),
        countQueueRows(args),
    ]);
    return { rows, total };
}

export const myQueue: ToolFactory = (role) => {
    // ID 45: own tabs only — the pool (unassigned / team / territory /
    // unclaimed) is not browsable from the Assistant.
    const tabs: readonly string[] = role === "asm" ? ASM_OWN_TABS : ISR_OWN_TABS;
    const labels: Record<string, string> = role === "asm" ? ASM_TAB_LABELS : TAB_LABELS;
    return defineTool({
        name: "my_queue",
        kind: "read",
        description:
            "List leads in one of the user's own CRM queue tabs, exactly as the screen shows them (10 per page, plus the total; " +
            "page 2 = rows 11–20, for \"next / more / aur dikhao\"). " +
            `Tabs: ${tabs.map((t) => `${t} = "${labels[t]}"`).join("; ")}.`,
        schema: z.object({
            tab: z.enum(tabs as unknown as [string, ...string[]]),
            search: z.string().trim().min(2).max(60).optional().describe("Optional name / shop / phone filter within the tab"),
            interest: z
                .enum(["hot", "warm", "cold"])
                .optional()
                .describe("Optional: only this temperature within the tab (the screen's Interest filter)"),
            page: z.number().int().min(1).max(PAGE_MAX).optional().describe("Page of 10, default 1"),
        }),
        run: async (ctx, input): Promise<ToolResult> => {
            const { rows, total } = await queueRowsForTool(ctx.user, input.tab, input.search, input.interest, input.page);
            return {
                kind: "leads",
                title:
                    labels[input.tab] +
                    (input.interest ? ` · ${input.interest}` : "") +
                    (input.search ? ` · "${input.search}"` : ""),
                rows: rows.map((r) => toLeadSummary(r, ctx.user)),
                total,
                crm_url: queueUrl(ctx.user),
                paging: { page: input.page ?? 1, page_size: MAX_TOOL_ROWS, args: pagingArgs(input) },
            };
        },
    });
};
