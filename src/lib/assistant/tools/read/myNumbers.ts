// my_numbers — "how am I doing": the performance page's figures for the
// caller only (buildSalesDashboard pinned to the user + their targets). Gate 3.

import { z } from "zod";
import { defineTool, type ToolFactory } from "../spec";

export const myNumbers: ToolFactory = () => defineTool({
    name: "my_numbers",
    kind: "read",
    description:
        "The user's own numbers against target for a month: each metric, its pro-rated target, RAG status and the definition used.",
    schema: z.object({
        period: z.enum(["this_month", "last_month"]).default("this_month"),
    }),
    run: async () => ({ kind: "unavailable", message: "Your numbers arrive in the next release." }),
});
