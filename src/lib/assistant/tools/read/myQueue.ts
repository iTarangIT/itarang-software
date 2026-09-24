// my_queue — list one of the user's own queue tabs, as the screen does.
// Gate 3 wires fetchQueueRows / fetchAsmQueueRows; Gate 2 is the schema.

import { z } from "zod";
import { QUEUE_TABS, TAB_LABELS } from "@/lib/inside-sales/types";
import { ASM_QUEUE_TABS, ASM_TAB_LABELS } from "@/lib/asm/types";
import { defineTool, type ToolFactory } from "../spec";

export const myQueue: ToolFactory = (role) => {
    const tabs = role === "asm" ? ASM_QUEUE_TABS : QUEUE_TABS;
    const labels: Record<string, string> = role === "asm" ? ASM_TAB_LABELS : TAB_LABELS;
    return defineTool({
        name: "my_queue",
        kind: "read",
        description:
            "List leads in one of the user's own CRM queue tabs, exactly as the screen shows them (max 10). " +
            `Tabs: ${tabs.map((t) => `${t} = "${labels[t]}"`).join("; ")}.`,
        schema: z.object({
            tab: z.enum(tabs as unknown as [string, ...string[]]),
            search: z.string().trim().min(2).max(60).optional().describe("Optional name / shop / phone filter within the tab"),
        }),
        run: async () => ({ kind: "unavailable", message: "Queue lists arrive in the next release." }),
    });
};
