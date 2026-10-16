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
import { MAX_TOOL_ROWS, type AssistantUser, type ToolResult } from "../../types";
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

/** Exported so the Gate 3 equality check calls the builders the same way. */
export async function queueRowsForTool(
    user: AssistantUser,
    tab: string,
    search?: string | null,
    interest?: string | null,
) {
    const q = search?.trim() || null;
    const params = screenParams(interest);
    // ID 155: a manager's own tabs cover the team, exactly as the queue routes
    // (and their badge counts) widen them — empty for everyone else.
    const teamMemberIds = await teamForOwnScopedViewer(user);
    if (user.role === "asm") {
        const { filters, sort, visitStatus, visitOutcome } = readAsmQueueFilters(params);
        const args = { tab: tab as AsmQueueTab, asmId: user.id, q, filters, visitStatus, visitOutcome, teamMemberIds };
        const [rows, total] = await Promise.all([
            fetchAsmQueueRows({ ...args, page: 1, limit: SCREEN_PAGE_SIZE, sort }),
            countAsmQueueRows(args),
        ]);
        return { rows: rows.slice(0, MAX_TOOL_ROWS), total };
    }
    const filters = readQueueFilters(params);
    const sort = readQueueSort(params);
    const args = { tab: tab as QueueTab, userId: user.id, q, filters, neodoveOnly: false, callbackOnly: false, teamMemberIds };
    const [rows, total] = await Promise.all([
        fetchQueueRows({ ...args, page: 1, limit: SCREEN_PAGE_SIZE, sort }),
        countQueueRows(args),
    ]);
    return { rows: rows.slice(0, MAX_TOOL_ROWS), total };
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
            "List leads in one of the user's own CRM queue tabs, exactly as the screen shows them (first 10, plus the total). " +
            `Tabs: ${tabs.map((t) => `${t} = "${labels[t]}"`).join("; ")}.`,
        schema: z.object({
            tab: z.enum(tabs as unknown as [string, ...string[]]),
            search: z.string().trim().min(2).max(60).optional().describe("Optional name / shop / phone filter within the tab"),
            interest: z
                .enum(["hot", "warm", "cold"])
                .optional()
                .describe("Optional: only this temperature within the tab (the screen's Interest filter)"),
        }),
        run: async (ctx, input): Promise<ToolResult> => {
            const { rows, total } = await queueRowsForTool(ctx.user, input.tab, input.search, input.interest);
            return {
                kind: "leads",
                title:
                    labels[input.tab] +
                    (input.interest ? ` · ${input.interest}` : "") +
                    (input.search ? ` · "${input.search}"` : ""),
                rows: rows.map((r) => toLeadSummary(r, ctx.user)),
                total,
                crm_url: queueUrl(ctx.user),
            };
        },
    });
};
