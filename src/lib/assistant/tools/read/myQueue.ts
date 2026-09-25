// my_queue — list one of the user's own queue tabs, exactly as the screen does
// (BRD §9.1). Calls the SAME builders as /api/inside-sales/queue and
// /api/asm/queue, with the SAME defaults those routes derive from an empty
// query string — so row N here is row N on the screen.

import { z } from "zod";
import { QUEUE_TABS, TAB_LABELS, type QueueTab } from "@/lib/inside-sales/types";
import { ASM_QUEUE_TABS, ASM_TAB_LABELS, type AsmQueueTab } from "@/lib/asm/types";
import { countQueueRows, fetchQueueRows } from "@/lib/inside-sales/queryBuilder";
import { countAsmQueueRows, fetchAsmQueueRows } from "@/lib/asm/queryBuilder";
import { readQueueFilters } from "@/lib/leads/queueFilters";
import { readQueueSort } from "@/lib/leads/queueSort";
import { readAsmQueueFilters } from "@/lib/asm/queueFilterParams";
import { MAX_TOOL_ROWS, type AssistantUser, type ToolResult } from "../../types";
import { defineTool, type ToolFactory } from "../spec";
import { queueUrl, toLeadSummary } from "../leads";

/** The screen's own defaults: what its route reads from `?` with no params. */
const NO_PARAMS = () => new URLSearchParams();

/** Exported so the Gate 3 equality check calls the builders the same way. */
export async function queueRowsForTool(user: AssistantUser, tab: string, search?: string | null) {
    const q = search?.trim() || null;
    if (user.role === "asm") {
        const { filters, sort, visitStatus, visitOutcome } = readAsmQueueFilters(NO_PARAMS());
        const args = { tab: tab as AsmQueueTab, asmId: user.id, q, filters, visitStatus, visitOutcome };
        const [rows, total] = await Promise.all([
            fetchAsmQueueRows({ ...args, page: 1, limit: MAX_TOOL_ROWS, sort }),
            countAsmQueueRows(args),
        ]);
        return { rows, total };
    }
    const filters = readQueueFilters(NO_PARAMS());
    const sort = readQueueSort(NO_PARAMS());
    const args = { tab: tab as QueueTab, userId: user.id, q, filters, neodoveOnly: false, callbackOnly: false };
    const [rows, total] = await Promise.all([
        fetchQueueRows({ ...args, page: 1, limit: MAX_TOOL_ROWS, sort }),
        countQueueRows(args),
    ]);
    return { rows, total };
}

export const myQueue: ToolFactory = (role) => {
    const tabs = role === "asm" ? ASM_QUEUE_TABS : QUEUE_TABS;
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
        }),
        run: async (ctx, input): Promise<ToolResult> => {
            const { rows, total } = await queueRowsForTool(ctx.user, input.tab, input.search);
            return {
                kind: "leads",
                title: labels[input.tab] + (input.search ? ` · "${input.search}"` : ""),
                rows: rows.map((r) => toLeadSummary(r, ctx.user)),
                total,
                crm_url: queueUrl(ctx.user),
            };
        },
    });
};
